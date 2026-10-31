# ElysaPay · Elysium yönetici rehberi

Bu rehber, ElysaPay'i Elysium Testnet'te denemek ve **9 Kasım 2026**'da planlanan Elysium mainnet'e geçirmek için
yönetici olarak yapacağın her adımı sırasıyla anlatır. Bütün deploy ve mint işlemleri **senin kendi cüzdanından**
imzalanır; sunucu hiçbir anahtar tutmaz, yalnızca işlemleri zincirden geri okuyup denetim kaydına (audit log) yazar.

## Elysium hakkında bilinenler (31 Ekim 2026 itibarıyla)

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 99801 (`0x185d9`) | 99901 (`0x1863d`), Conduit'in deploy ettiği; Kinetiq henüz resmi olarak yayımlamadı |
| RPC | `https://testnet-rpc.elysium.kinetiq.xyz` (yedek: `https://rpc-elysium-testnet.t.conduit.xyz`) | Lansmanda Kinetiq yayımlayacak |
| Explorer | `https://explorer-elysium-testnet.t.conduit.xyz` | Lansmanda |
| Gas | HYPE (18 ondalık) | HYPE |
| Üst zincir | HyperEVM Testnet (998) | HyperEVM (999) |
| Faucet / köprü | `elysium.kinetiq.xyz/testnet-faucet`, `/testnet-bridge` | HyperEVM'den 1:1 köprü |

- Blok süresi ~100 ms hedefleniyor (testnette ölçtüğümüz: 105–120 ms).
- Tek sıralayıcı (Conduit), açık mempool yok; işlemler öncelik ücretine göre sıralanır.
- Düz bir HYPE transferi ~21.140 gas tutar (üst zincire yazma maliyeti eklenir). 21.000 sabit yazılmamalı; ElysaPay
  gas'ı her zaman tahminden alır.
- HyperCore precompile'ları (piyasa verisi, emir gönderme) Elysium'da henüz yok; Kinetiq bunları mainnet'ten yaklaşık
  dört hafta sonra bir ArbOS güncellemesiyle getirmeyi planlıyor. O zamana kadar piyasa şeridi Hyperliquid'in açık
  API'sinden okunur.

## 0. Sunucu ayarı

`.env` dosyasında admin cüzdanını tanımla (virgülle birden fazla adres verebilirsin):

```bash
ADMIN_WALLET_ADDRESSES=0xSeninCuzdanin
# İsteğe bağlı: sunucunun kendi okumaları için anahtarlı bir sağlayıcı RPC'si (tarayıcıya hiç gönderilmez)
ELYSIUM_TESTNET_RPC_URL=
ELYSIUM_MAINNET_RPC_URL=
```

Başka bir Elysium ayarı gerekmez: kontrat adresleri ve mainnet RPC'si admin panelinden imzalı değişiklikle kaydedilir.

## 1. Testnet'te kurulum (bugün yapılabilir)

1. Cüzdanına testnet HYPE al: faucet ya da HyperEVM Testnet'ten köprü.
2. `/admin` sayfasını aç, admin cüzdanınla bağlan ve **Elysium** sekmesine geç. Üstte **Elysium Testnet** seçili olsun.
3. **Switch my wallet here** ile cüzdanını Elysium Testnet'e geçir (cüzdan ağı tanımıyorsa ElysaPay ekler).
4. **Deploy from your wallet** kartında:
   - **ElysaPay router**: `Treasury` alanına %1 ücretin gideceği adresi yaz (varsayılan: senin cüzdanın).
     Router'ın sahibi yoktur ve yükseltilemez; treasury sonradan değişmez. **Deploy on testnet** → cüzdanında imzala.
   - İşlem onaylanınca adres alana kendiliğinden gelir. **Check on chain** ile kodun ElysaPay derlemesi olduğunu
     gör, sonra **Register (signed)** ile kaydet (cüzdan bir mesaj imzalatır, işlem denetim kaydına yazılır).
5. İstersen aynı kartta **ELYSA token** (ERC-20, tavanlı arz) ve **Elysian Pass** (ERC-721 üyelik kartı, istersen
   soulbound) deploy edip kaydet. İkisinin de sahibi deploy eden cüzdandır, yani sensin.
6. Masaüstünde (`/app`) **Elysium** sekmesinden doğrulanmış bir handle'a küçük bir HYPE ödemesi yap ve
   **Payments** tablosunda göründüğünü kontrol et.

## 2. Mint işlemleri (testnet ve mainnet için aynı)

Kayıtlı token ve pass kartları, Elysium sekmesinde ağ seçimine göre görünür. Okuma için cüzdanın o ağda olmalı.

**ELYSA token**
- **Mint**: alıcı (adres ya da `x:@kullanici` gibi doğrulanmış handle), miktar ve zincire yazılan kısa bir not.
- **Airdrop**: her satıra `adres,miktar` ya da `x:@kullanici,miktar` (en fazla 200 satır, tek işlem).
- **Pause / Resume minting**: mint'i geçici durdurur. Sahipler token'larını her zaman transfer edip yakabilir.
- **Close minting forever**: arzı kalıcı olarak kilitler (onay için `CLOSE` yazman istenir). Geri alınamaz.

**Elysian Pass**
- Kademe seç (1 Genesis, 2 Builder, 3 Trader, 4 Community), her satıra bir adres ya da handle yaz (en fazla 100).
- **Set URI** ile metadata adresini (ör. `ipfs://…/`) ayarla; **Freeze metadata** ile kalıcı dondur (`FREEZE`).
- Soulbound pass'ler mint'ten sonra hiç taşınamaz; sahibi yine de yakabilir.

**Sahiplik**: iki adımlıdır. Sahip yeni adresi **Name** ile atar, yeni sahip kendi cüzdanından **Accept ownership**
yapar. Mainnet'te sahipliği bir multisig'e (ör. Safe) devretmen önerilir.

Mainnet'te her deploy ve mint, ek bir tarayıcı onayı ister. Her işlem onaylandıktan sonra denetim kaydına
`elysium.tx` olarak yazılır.

## 3. Mainnet'e geçiş (9 Kasım)

Elysium sekmesinde **Elysium** (mainnet) seçiliyken sağdaki **Mainnet launch** kartı geri sayımı ve kontrol listesini
gösterir.

1. Kinetiq resmi mainnet RPC ve explorer adreslerini yayımladığında bunları **Official mainnet RPC** ve
   **Official explorer** alanlarına yaz.
2. **Switch on**: sunucu RPC'nin gerçekten chain **99901**'e cevap verdiğini kontrol eder; başka bir zincir ya da
   adında "testnet" geçen bir RPC reddedilir. Chain ID farklı yayımlanırsa bu kontrol mainnet'i açmaz: o durumda
   `src/domain/elysium.ts` içindeki `ELYSIUM_MAINNET.chainId` değerini güncelleyip yeniden deploy et.
3. Cüzdanına mainnet HYPE köprüle (HyperEVM → Elysium, 1:1).
4. Router'ı mainnet'te deploy et (treasury için multisig önerilir) ve kaydet. Gerekirse ELYSA ve Pass'i de deploy et.
5. Masaüstünde Mainnet sekmesinden küçük bir gerçek ödeme yap. Mainnet açılınca masaüstü kendiliğinden mainnet'i
   varsayılan yapar.
6. Bir sorun olursa: **Pauses and notice** sekmesinden **Elysium HYPE payments** özelliğini duraklat (onaylanmış
   ödemeleri etkilemez) ya da Elysium sekmesinden ağı **Switch off** yap.

## Güvenlik notları

- Router: sahipsiz, yükseltilemez, ücret sabit (%1, yukarı yuvarlanır), fon tutmaz, reentrancy korumalı, alıcının
  ödemeyi reddetmesi durumunda işlem tamamen geri alınır. Doğrudan HYPE gönderimini reddeder.
- Sunucu bir adresi yalnızca çalışan kodu ElysaPay derlemesiyle (immutable alanlar dışında) bire bir aynıysa ve
  token/pass'in sahibi bir admin cüzdanıysa kaydeder.
- Ödeme kaydı yalnızca zincirdeki `Paid` olayından yapılır: gönderen senin cüzdanın, hedef kayıtlı router ve alıcı
  handle'ın şu anki doğrulanmış cüzdanı olmalıdır.
- Kontratlar bağımsız bir denetimden geçmedi. Mainnet'te önce küçük tutarlarla başla.
