/** Simple rounded glyphs for the five identity providers. They label a row that names the provider in text too. */
export function ProviderIcon({ provider, className = "" }: { provider: string; className?: string }) {
  const id = provider.toLowerCase();
  return <svg className={`provider-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {id === "github" ? <>
      <path fill="currentColor" d="M5.2 4.4c1.3 0 3 1 3.8 1.8a10 10 0 0 1 6 0c.8-.8 2.5-1.8 3.8-1.8.4 1.4.2 2.9-.2 3.9.9 1 1.4 2.3 1.4 3.8 0 4.6-3.3 7.4-8 7.4s-8-2.8-8-7.4c0-1.5.5-2.8 1.4-3.8-.4-1-.6-2.5-.2-3.9Z" />
      <circle className="provider-cutout" cx="9.2" cy="12.4" r="1.25" />
      <circle className="provider-cutout" cx="14.8" cy="12.4" r="1.25" />
      <path className="provider-cutout-line" d="M10.6 15.6c.9.6 1.9.6 2.8 0" />
    </> : id === "x" ? <>
      <path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" d="M6 5.5 18 18.5M18 5.5 6 18.5" />
    </> : id === "telegram" ? <>
      <path fill="currentColor" d="M20.3 4.6c.6-.2 1.2.3 1 1l-2.9 13.1c-.1.7-.9 1-1.5.6l-4.3-3.1-2.2 2.1c-.3.3-.8.1-.8-.3l.1-3.2 7.4-6.8c.3-.3 0-.6-.4-.4l-9.1 5.8-3.9-1.3c-.8-.3-.8-1.3 0-1.6l16.6-5.9Z" />
    </> : id === "discord" ? <>
      <path fill="currentColor" d="M7.4 5.6a15 15 0 0 1 3-.9l.4.8a13 13 0 0 1 2.4 0l.4-.8c1 .2 2 .5 3 .9 2 2.9 2.8 5.9 2.5 9.4a12 12 0 0 1-3.7 1.9l-.8-1.3c.5-.2.9-.4 1.3-.7l-.3-.2a9.8 9.8 0 0 1-7.2 0l-.3.2c.4.3.8.5 1.3.7l-.8 1.3A12 12 0 0 1 4.9 15c-.3-3.5.5-6.5 2.5-9.4Z" />
      <circle className="provider-cutout" cx="9.5" cy="11.8" r="1.4" />
      <circle className="provider-cutout" cx="14.5" cy="11.8" r="1.4" />
    </> : id === "farcaster" ? <>
      <path fill="currentColor" d="M5.5 4.5h13v2.4h1.6l-.8 2.6h-.8v8.1h1.2v1.9h-5.4v-1.9h1.1v-4.1a3.4 3.4 0 0 0-6.8 0v4.1h1.1v1.9H4.3v-1.9h1.2V9.5h-.8l-.8-2.6h1.6Z" />
    </> : <>
      <circle fill="currentColor" cx="12" cy="12" r="7" />
    </>}
  </svg>;
}
