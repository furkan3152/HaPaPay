import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { rememberInviteFromUrl } from "./referral-desk";
import "./styles.css";

/**
 * Whatever goes wrong while the page draws, it says so and offers a reload instead of going blank (audit,
 * 2026-10-06: one malformed link left an empty page).
 */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="not-found-page" aria-labelledby="page-error-title"><div className="not-found-card">
      <h1 id="page-error-title">This page could not be shown</h1>
      <p>Something on this page failed to load. Nothing was signed or sent.</p>
      <div className="not-found-links"><button type="button" className="home-open" onClick={() => window.location.reload()}>Reload the page</button><a href="/app">Open the desk</a><a href="/">Home</a></div>
    </div></section>;
  }
}

// An invite link (`?ref=CODE`) leaves its code for the desk to send once the wallet is verified.
rememberInviteFromUrl();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PageBoundary><App /></PageBoundary></React.StrictMode>,
);
