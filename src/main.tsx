import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { ElysaApp } from "./elysa/ElysaApp";
import { rememberInviteFromUrl } from "./referral-desk";
import { installSoundCues } from "./sound";

/** Whatever goes wrong while the page draws, it says so and offers a reload instead of going blank. */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: "#EEF2FF", background: "#05070F", fontFamily: "system-ui" }} aria-labelledby="page-error-title">
      <div style={{ textAlign: "center" }}>
        <h1 id="page-error-title">This page could not be shown</h1>
        <p>Something failed to load. Nothing was signed or sent.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload the page</button>
      </div>
    </section>;
  }
}

// An invite link (`?ref=CODE`) leaves its code for the app to send once the wallet is verified.
rememberInviteFromUrl();
// Soft sound cues for presses (a per-viewer choice in the top bar).
installSoundCues();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PageBoundary><ElysaApp /></PageBoundary></React.StrictMode>,
);
