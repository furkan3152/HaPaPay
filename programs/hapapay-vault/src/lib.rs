//! HaPaPay's Solana vault, security revision 1. It is the Solana counterpart of `contracts/StockClaimEscrow.sol`:
//!
//! * a payer funds a payment for a social identity (`keccak256(platform hash ‖ provider user ID hash)`), with an
//!   expiry at most 31 days away; the vault holds the amount and a 1% fee in a token account owned by the payment;
//! * the identity's verified owner claims it with an ed25519 attestation from HaPaPay's claim attestor that names
//!   this program, the payment, the identity, the mint, the claiming wallet, the amount, the expiry and a short
//!   deadline; the claimer receives the amount and the treasury the fee;
//! * after the expiry the payer takes everything back, with no attestation;
//! * a settled payment stays on chain as a tombstone, so its ID can never be funded again.
//!
//! The settings (owner, attestor, treasury) are written once by the deployer, which then hands the upgrade authority to
//! the operator, so the program can later be closed. Only the owner can replace the attestor, the treasury or itself.

// solana-program 2.3 marks the loader and system modules deprecated in favour of split crates with the same items.
#![allow(deprecated)]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable,
    clock::Clock,
    ed25519_program, entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    keccak,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{instructions as sysvar_instructions, Sysvar},
};

entrypoint!(process_instruction);

pub const SECURITY_REVISION: u8 = 1;
pub const MAX_CLAIM_WINDOW: i64 = 31 * 24 * 60 * 60;
pub const FEE_BPS: u16 = 100;
pub const CLAIM_DOMAIN: &[u8; 32] = b"HAPAPAY::SOLANA-VAULT::CLAIM::V1";

const CONFIG_SEED: &[u8] = b"config";
const PAYMENT_SEED: &[u8] = b"payment";
const CONFIG_TAG: [u8; 8] = *b"HAPA-CFG";
const PAYMENT_TAG: [u8; 8] = *b"HAPA-PAY";
const CONFIG_LEN: usize = 108;
const PAYMENT_LEN: usize = 163;
const CLAIM_MESSAGE_LEN: usize = 32 * 6 + 8 * 3;

const STATUS_OPEN: u8 = 1;
const STATUS_CLAIMED: u8 = 2;
const STATUS_REFUNDED: u8 = 3;

const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

#[repr(u32)]
#[derive(Clone, Copy, Debug)]
pub enum VaultError {
    InvalidInstruction = 1,
    AlreadyInitialized,
    NotInitialized,
    NotOwner,
    NotUpgradeAuthority,
    InvalidAccount,
    InvalidAmount,
    InvalidExpiry,
    PaymentExists,
    PaymentUnavailable,
    ClaimExpired,
    InvalidClaim,
    NotPayer,
    RefundNotReady,
    TransferMismatch,
    InvalidTokenProgram,
    MissingSignature,
}

impl From<VaultError> for ProgramError {
    fn from(error: VaultError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

fn fail<T>(error: VaultError) -> Result<T, ProgramError> {
    Err(error.into())
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], ProgramError> {
        let end = self.offset.checked_add(N).ok_or(VaultError::InvalidInstruction)?;
        let slice = self.data.get(self.offset..end).ok_or(VaultError::InvalidInstruction)?;
        self.offset = end;
        let mut out = [0u8; N];
        out.copy_from_slice(slice);
        Ok(out)
    }
    fn pubkey(&mut self) -> Result<Pubkey, ProgramError> {
        Ok(Pubkey::new_from_array(self.bytes::<32>()?))
    }
    fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(self.bytes::<8>()?))
    }
    fn i64(&mut self) -> Result<i64, ProgramError> {
        Ok(i64::from_le_bytes(self.bytes::<8>()?))
    }
    fn finish(&self) -> ProgramResult {
        if self.offset == self.data.len() { Ok(()) } else { fail(VaultError::InvalidInstruction) }
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(VaultError::InvalidInstruction)?;
    let mut input = Reader::new(rest);
    match tag {
        0 => {
            let owner = input.pubkey()?;
            let verifier = input.pubkey()?;
            let treasury = input.pubkey()?;
            input.finish()?;
            initialize(program_id, accounts, owner, verifier, treasury)
        }
        1 => {
            let payment_id = input.bytes::<32>()?;
            let platform_hash = input.bytes::<32>()?;
            let provider_user_id_hash = input.bytes::<32>()?;
            let amount = input.u64()?;
            let expiry = input.i64()?;
            input.finish()?;
            create_payment(program_id, accounts, payment_id, platform_hash, provider_user_id_hash, amount, expiry)
        }
        2 => {
            let payment_id = input.bytes::<32>()?;
            let claim_deadline = input.i64()?;
            input.finish()?;
            claim(program_id, accounts, payment_id, claim_deadline)
        }
        3 => {
            let payment_id = input.bytes::<32>()?;
            input.finish()?;
            refund(program_id, accounts, payment_id)
        }
        4..=6 => {
            let value = input.pubkey()?;
            input.finish()?;
            update_config(program_id, accounts, *tag, value)
        }
        _ => fail(VaultError::InvalidInstruction),
    }
}

struct Config {
    bump: u8,
    fee_bps: u16,
    owner: Pubkey,
    verifier: Pubkey,
    treasury: Pubkey,
}

fn config_address(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}

fn read_config(program_id: &Pubkey, account: &AccountInfo) -> Result<Config, ProgramError> {
    if account.owner != program_id || account.key != &config_address(program_id).0 {
        return fail(VaultError::NotInitialized);
    }
    let data = account.try_borrow_data()?;
    if data.len() != CONFIG_LEN || data[0..8] != CONFIG_TAG || data[8] != SECURITY_REVISION {
        return fail(VaultError::NotInitialized);
    }
    Ok(Config {
        bump: data[9],
        fee_bps: u16::from_le_bytes([data[10], data[11]]),
        owner: Pubkey::new_from_array(data[12..44].try_into().unwrap()),
        verifier: Pubkey::new_from_array(data[44..76].try_into().unwrap()),
        treasury: Pubkey::new_from_array(data[76..108].try_into().unwrap()),
    })
}

fn write_config(account: &AccountInfo, config: &Config) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    data[0..8].copy_from_slice(&CONFIG_TAG);
    data[8] = SECURITY_REVISION;
    data[9] = config.bump;
    data[10..12].copy_from_slice(&config.fee_bps.to_le_bytes());
    data[12..44].copy_from_slice(config.owner.as_ref());
    data[44..76].copy_from_slice(config.verifier.as_ref());
    data[76..108].copy_from_slice(config.treasury.as_ref());
    Ok(())
}

struct Payment {
    bump: u8,
    status: u8,
    payer: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    identity_key: [u8; 32],
    amount: u64,
    fee: u64,
    expiry: i64,
}

fn read_payment(program_id: &Pubkey, account: &AccountInfo, payment_id: &[u8; 32]) -> Result<Payment, ProgramError> {
    if account.owner != program_id {
        return fail(VaultError::PaymentUnavailable);
    }
    let data = account.try_borrow_data()?;
    if data.len() != PAYMENT_LEN || data[0..8] != PAYMENT_TAG || data[8] != SECURITY_REVISION {
        return fail(VaultError::PaymentUnavailable);
    }
    let bump = data[9];
    let expected = Pubkey::create_program_address(&[PAYMENT_SEED, payment_id, &[bump]], program_id).map_err(|_| VaultError::PaymentUnavailable)?;
    if account.key != &expected {
        return fail(VaultError::PaymentUnavailable);
    }
    Ok(Payment {
        bump,
        status: data[10],
        payer: Pubkey::new_from_array(data[11..43].try_into().unwrap()),
        mint: Pubkey::new_from_array(data[43..75].try_into().unwrap()),
        token_program: Pubkey::new_from_array(data[75..107].try_into().unwrap()),
        identity_key: data[107..139].try_into().unwrap(),
        amount: u64::from_le_bytes(data[139..147].try_into().unwrap()),
        fee: u64::from_le_bytes(data[147..155].try_into().unwrap()),
        expiry: i64::from_le_bytes(data[155..163].try_into().unwrap()),
    })
}

fn write_payment(account: &AccountInfo, payment: &Payment) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    data[0..8].copy_from_slice(&PAYMENT_TAG);
    data[8] = SECURITY_REVISION;
    data[9] = payment.bump;
    data[10] = payment.status;
    data[11..43].copy_from_slice(payment.payer.as_ref());
    data[43..75].copy_from_slice(payment.mint.as_ref());
    data[75..107].copy_from_slice(payment.token_program.as_ref());
    data[107..139].copy_from_slice(&payment.identity_key);
    data[139..147].copy_from_slice(&payment.amount.to_le_bytes());
    data[147..155].copy_from_slice(&payment.fee.to_le_bytes());
    data[155..163].copy_from_slice(&payment.expiry.to_le_bytes());
    Ok(())
}

fn set_status(account: &AccountInfo, status: u8) -> ProgramResult {
    account.try_borrow_mut_data()?[10] = status;
    Ok(())
}

/// Creates a program-owned account at a PDA, even when someone sent it lamports first (which would make a plain
/// `create_account` fail and block the address).
fn create_pda<'a>(payer: &AccountInfo<'a>, account: &AccountInfo<'a>, system: &AccountInfo<'a>, program_id: &Pubkey, space: usize, seeds: &[&[u8]]) -> ProgramResult {
    if !account.data_is_empty() || account.owner != &system_program::ID {
        return fail(VaultError::PaymentExists);
    }
    let required = Rent::get()?.minimum_balance(space);
    if account.lamports() == 0 {
        return invoke_signed(&system_instruction::create_account(payer.key, account.key, required, space as u64, program_id), &[payer.clone(), account.clone(), system.clone()], &[seeds]);
    }
    let missing = required.saturating_sub(account.lamports());
    if missing > 0 {
        invoke(&system_instruction::transfer(payer.key, account.key, missing), &[payer.clone(), account.clone(), system.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(account.key, space as u64), &[account.clone(), system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(account.key, program_id), &[account.clone(), system.clone()], &[seeds])
}

fn token_account_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM).0
}

/// A token account's balance, after checking it holds this mint and is owned by this token program.
fn token_balance(account: &AccountInfo, mint: &Pubkey, token_program: &Pubkey) -> Result<u64, ProgramError> {
    if account.owner != token_program {
        return fail(VaultError::InvalidAccount);
    }
    let data = account.try_borrow_data()?;
    if data.len() < 72 || data[0..32] != mint.to_bytes() {
        return fail(VaultError::InvalidAccount);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

fn mint_decimals(mint: &AccountInfo, token_program: &Pubkey) -> Result<u8, ProgramError> {
    if mint.owner != token_program {
        return fail(VaultError::InvalidAccount);
    }
    let data = mint.try_borrow_data()?;
    if data.len() < 82 || data[45] != 1 {
        return fail(VaultError::InvalidAccount);
    }
    Ok(data[44])
}

fn check_token_program(account: &AccountInfo) -> ProgramResult {
    if account.key == &TOKEN_PROGRAM || account.key == &TOKEN_2022_PROGRAM { Ok(()) } else { fail(VaultError::InvalidTokenProgram) }
}

fn transfer_checked<'a>(token_program: &AccountInfo<'a>, source: &AccountInfo<'a>, mint: &AccountInfo<'a>, destination: &AccountInfo<'a>, authority: &AccountInfo<'a>, amount: u64, decimals: u8, seeds: &[&[&[u8]]]) -> ProgramResult {
    let mut data = Vec::with_capacity(10);
    data.push(12);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let instruction = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    invoke_signed(&instruction, &[source.clone(), mint.clone(), destination.clone(), authority.clone(), token_program.clone()], seeds)
}

fn close_token_account<'a>(token_program: &AccountInfo<'a>, account: &AccountInfo<'a>, destination: &AccountInfo<'a>, authority: &AccountInfo<'a>, seeds: &[&[&[u8]]]) -> ProgramResult {
    let instruction = Instruction {
        program_id: *token_program.key,
        accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new(*destination.key, false), AccountMeta::new_readonly(*authority.key, true)],
        data: vec![9],
    };
    invoke_signed(&instruction, &[account.clone(), destination.clone(), authority.clone(), token_program.clone()], seeds)
}

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Writes the settings once. Only the program's upgrade authority may do it, so nobody can race the deployer.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], owner: Pubkey, verifier: Pubkey, treasury: Pubkey) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let program = next_account_info(iter)?;
    let program_data = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if !authority.is_signer {
        return fail(VaultError::MissingSignature);
    }
    if system.key != &system_program::ID || program.key != program_id || program.owner != &bpf_loader_upgradeable::ID {
        return fail(VaultError::InvalidAccount);
    }
    {
        let data = program.try_borrow_data()?;
        if data.len() < 36 || u32::from_le_bytes(data[0..4].try_into().unwrap()) != 2 || data[4..36] != program_data.key.to_bytes() {
            return fail(VaultError::InvalidAccount);
        }
    }
    {
        let data = program_data.try_borrow_data()?;
        if program_data.owner != &bpf_loader_upgradeable::ID || data.len() < 45 || u32::from_le_bytes(data[0..4].try_into().unwrap()) != 3 {
            return fail(VaultError::InvalidAccount);
        }
        if data[12] != 1 || data[13..45] != authority.key.to_bytes() {
            return fail(VaultError::NotUpgradeAuthority);
        }
    }
    if owner == Pubkey::default() || verifier == Pubkey::default() || treasury == Pubkey::default() {
        return fail(VaultError::InvalidAccount);
    }
    let (address, bump) = config_address(program_id);
    if config.key != &address {
        return fail(VaultError::InvalidAccount);
    }
    if !config.data_is_empty() {
        return fail(VaultError::AlreadyInitialized);
    }
    create_pda(authority, config, system, program_id, CONFIG_LEN, &[CONFIG_SEED, &[bump]])?;
    write_config(config, &Config { bump, fee_bps: FEE_BPS, owner, verifier, treasury })
}

fn create_payment(program_id: &Pubkey, accounts: &[AccountInfo], payment_id: [u8; 32], platform_hash: [u8; 32], provider_user_id_hash: [u8; 32], amount: u64, expiry: i64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let config_account = next_account_info(iter)?;
    let payment = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let payer_token = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let associated_token_program = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if !payer.is_signer {
        return fail(VaultError::MissingSignature);
    }
    let config = read_config(program_id, config_account)?;
    check_token_program(token_program)?;
    if associated_token_program.key != &ASSOCIATED_TOKEN_PROGRAM || system.key != &system_program::ID {
        return fail(VaultError::InvalidAccount);
    }
    if payment_id == [0u8; 32] {
        return fail(VaultError::InvalidInstruction);
    }
    if amount == 0 {
        return fail(VaultError::InvalidAmount);
    }
    let time = now()?;
    if expiry <= time || expiry > time.checked_add(MAX_CLAIM_WINDOW).ok_or(VaultError::InvalidExpiry)? {
        return fail(VaultError::InvalidExpiry);
    }
    let decimals = mint_decimals(mint, token_program.key)?;
    let (address, bump) = Pubkey::find_program_address(&[PAYMENT_SEED, &payment_id], program_id);
    if payment.key != &address {
        return fail(VaultError::InvalidAccount);
    }
    if vault.key != &token_account_address(&address, mint.key, token_program.key) {
        return fail(VaultError::InvalidAccount);
    }
    let fee = ((amount as u128) * (config.fee_bps as u128) / 10_000) as u64;
    let total = amount.checked_add(fee).ok_or(VaultError::InvalidAmount)?;
    create_pda(payer, payment, system, program_id, PAYMENT_LEN, &[PAYMENT_SEED, &payment_id, &[bump]])?;
    let identity_key = keccak::hashv(&[&platform_hash, &provider_user_id_hash]).to_bytes();
    write_payment(payment, &Payment { bump, status: STATUS_OPEN, payer: *payer.key, mint: *mint.key, token_program: *token_program.key, identity_key, amount, fee, expiry })?;
    let create_vault = Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*vault.key, false),
            AccountMeta::new_readonly(*payment.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: vec![1],
    };
    invoke(&create_vault, &[payer.clone(), vault.clone(), payment.clone(), mint.clone(), system.clone(), token_program.clone(), associated_token_program.clone()])?;
    let before = token_balance(vault, mint.key, token_program.key)?;
    transfer_checked(token_program, payer_token, mint, vault, payer, total, decimals, &[])?;
    let after = token_balance(vault, mint.key, token_program.key)?;
    if after.checked_sub(before) != Some(total) {
        return fail(VaultError::TransferMismatch);
    }
    Ok(())
}

/// The exact message the claim attestor signs for one claim.
pub fn claim_message(program_id: &Pubkey, payment_id: &[u8; 32], identity_key: &[u8; 32], mint: &Pubkey, recipient: &Pubkey, amount: u64, expiry: i64, claim_deadline: i64) -> [u8; CLAIM_MESSAGE_LEN] {
    let mut message = [0u8; CLAIM_MESSAGE_LEN];
    message[0..32].copy_from_slice(CLAIM_DOMAIN);
    message[32..64].copy_from_slice(program_id.as_ref());
    message[64..96].copy_from_slice(payment_id);
    message[96..128].copy_from_slice(identity_key);
    message[128..160].copy_from_slice(mint.as_ref());
    message[160..192].copy_from_slice(recipient.as_ref());
    message[192..200].copy_from_slice(&amount.to_le_bytes());
    message[200..208].copy_from_slice(&expiry.to_le_bytes());
    message[208..216].copy_from_slice(&claim_deadline.to_le_bytes());
    message
}

/// The instruction right before this one must be the ed25519 precompile checking exactly one signature, by the
/// configured attestor, over exactly this message, with every offset pointing into that instruction itself.
fn check_attestation(instructions: &AccountInfo, verifier: &Pubkey, message: &[u8]) -> ProgramResult {
    if instructions.key != &sysvar_instructions::ID {
        return fail(VaultError::InvalidAccount);
    }
    let current = sysvar_instructions::load_current_index_checked(instructions)?;
    if current == 0 {
        return fail(VaultError::InvalidClaim);
    }
    let previous = sysvar_instructions::load_instruction_at_checked((current - 1) as usize, instructions)?;
    if previous.program_id != ed25519_program::ID || !previous.accounts.is_empty() {
        return fail(VaultError::InvalidClaim);
    }
    let data = previous.data.as_slice();
    if data.len() < 16 || data[0] != 1 {
        return fail(VaultError::InvalidClaim);
    }
    let field = |index: usize| u16::from_le_bytes([data[2 + index * 2], data[3 + index * 2]]);
    let (signature_offset, signature_index, key_offset, key_index, message_offset, message_size, message_index) = (field(0), field(1), field(2), field(3), field(4), field(5), field(6));
    if signature_index != u16::MAX || key_index != u16::MAX || message_index != u16::MAX {
        return fail(VaultError::InvalidClaim);
    }
    let slice = |offset: u16, size: usize| data.get(offset as usize..(offset as usize).checked_add(size)?);
    slice(signature_offset, 64).ok_or(VaultError::InvalidClaim)?;
    let key = slice(key_offset, 32).ok_or(VaultError::InvalidClaim)?;
    let signed = slice(message_offset, message_size as usize).ok_or(VaultError::InvalidClaim)?;
    if key != verifier.as_ref() || signed != message {
        return fail(VaultError::InvalidClaim);
    }
    Ok(())
}

fn claim(program_id: &Pubkey, accounts: &[AccountInfo], payment_id: [u8; 32], claim_deadline: i64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let recipient = next_account_info(iter)?;
    let config_account = next_account_info(iter)?;
    let payment_account = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let recipient_token = next_account_info(iter)?;
    let treasury_token = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let instructions = next_account_info(iter)?;
    if !recipient.is_signer {
        return fail(VaultError::MissingSignature);
    }
    let config = read_config(program_id, config_account)?;
    let payment = read_payment(program_id, payment_account, &payment_id)?;
    if payment.status != STATUS_OPEN {
        return fail(VaultError::PaymentUnavailable);
    }
    if mint.key != &payment.mint || token_program.key != &payment.token_program || payer.key != &payment.payer {
        return fail(VaultError::InvalidAccount);
    }
    if vault.key != &token_account_address(payment_account.key, mint.key, token_program.key)
        || recipient_token.key != &token_account_address(recipient.key, mint.key, token_program.key)
        || treasury_token.key != &token_account_address(&config.treasury, mint.key, token_program.key)
    {
        return fail(VaultError::InvalidAccount);
    }
    let time = now()?;
    if time > payment.expiry || time > claim_deadline {
        return fail(VaultError::ClaimExpired);
    }
    let message = claim_message(program_id, &payment_id, &payment.identity_key, mint.key, recipient.key, payment.amount, payment.expiry, claim_deadline);
    check_attestation(instructions, &config.verifier, &message)?;
    set_status(payment_account, STATUS_CLAIMED)?;
    let held = token_balance(vault, mint.key, token_program.key)?;
    let owed = payment.amount.checked_add(payment.fee).ok_or(VaultError::InvalidAmount)?;
    if held < owed {
        return fail(VaultError::TransferMismatch);
    }
    let decimals = mint_decimals(mint, token_program.key)?;
    let seeds: &[&[u8]] = &[PAYMENT_SEED, &payment_id, &[payment.bump]];
    // The claimer gets the amount and anything sent to the vault on top of it; the treasury gets exactly the fee.
    transfer_checked(token_program, vault, mint, recipient_token, payment_account, held - payment.fee, decimals, &[seeds])?;
    if payment.fee > 0 {
        transfer_checked(token_program, vault, mint, treasury_token, payment_account, payment.fee, decimals, &[seeds])?;
    }
    close_token_account(token_program, vault, payer, payment_account, &[seeds])
}

fn refund(program_id: &Pubkey, accounts: &[AccountInfo], payment_id: [u8; 32]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let payment_account = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let payer_token = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    if !payer.is_signer {
        return fail(VaultError::MissingSignature);
    }
    let payment = read_payment(program_id, payment_account, &payment_id)?;
    if payment.status != STATUS_OPEN {
        return fail(VaultError::PaymentUnavailable);
    }
    if payer.key != &payment.payer {
        return fail(VaultError::NotPayer);
    }
    if mint.key != &payment.mint || token_program.key != &payment.token_program {
        return fail(VaultError::InvalidAccount);
    }
    if vault.key != &token_account_address(payment_account.key, mint.key, token_program.key)
        || payer_token.key != &token_account_address(payer.key, mint.key, token_program.key)
    {
        return fail(VaultError::InvalidAccount);
    }
    if now()? <= payment.expiry {
        return fail(VaultError::RefundNotReady);
    }
    set_status(payment_account, STATUS_REFUNDED)?;
    let held = token_balance(vault, mint.key, token_program.key)?;
    let decimals = mint_decimals(mint, token_program.key)?;
    let seeds: &[&[u8]] = &[PAYMENT_SEED, &payment_id, &[payment.bump]];
    if held > 0 {
        transfer_checked(token_program, vault, mint, payer_token, payment_account, held, decimals, &[seeds])?;
    }
    close_token_account(token_program, vault, payer, payment_account, &[seeds])
}

fn update_config(program_id: &Pubkey, accounts: &[AccountInfo], tag: u8, value: Pubkey) -> ProgramResult {
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?;
    let config_account = next_account_info(iter)?;
    if !owner.is_signer {
        return fail(VaultError::MissingSignature);
    }
    let mut config = read_config(program_id, config_account)?;
    if owner.key != &config.owner {
        return fail(VaultError::NotOwner);
    }
    if value == Pubkey::default() {
        return fail(VaultError::InvalidAccount);
    }
    match tag {
        4 => config.verifier = value,
        5 => config.treasury = value,
        _ => config.owner = value,
    }
    write_config(config_account, &config)
}
