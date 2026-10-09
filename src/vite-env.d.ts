/// <reference types="vite/client" />

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

type TelegramLoginUser = {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
};

/** Telegram's login script (telegram-widget.js) without widget attributes: a popup login that calls back with the user. */
type TelegramLoginApi = {
  auth(options: { bot_id: string; request_access?: boolean | "write" }, callback: (user: TelegramLoginUser | false) => void): void;
};

interface Window {
  ethereum?: EthereumProvider;
  Telegram?: { Login?: TelegramLoginApi };
}
