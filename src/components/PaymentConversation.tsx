import { useEffect, useRef } from "react";
import type { PaymentConversation as Conversation } from "../domain/payment-conversation";
import { BrandMark } from "./BrandMark";
import "./payment-conversation.css";

/**
 * The request log: each typed request and the desk's answer, newest at the bottom; while a draft is prepared the dotted
 * bird flaps beside it. The newest answer can offer complete requests to pick instead of typing one again; picking one
 * sends it as a new request, which is read like any other. Nothing here signs or sends.
 */
export function PaymentConversation({ conversation, status, onSuggestion, busy = false, statusBelow = false }: { conversation: Conversation; status: string; onSuggestion?: (request: string) => void; busy?: boolean; statusBelow?: boolean }) {
  const lastTurn = conversation.turns.at(-1);
  const showStatus = !statusBelow && statusShown(conversation, status);
  return <div className="payment-conversation">
    <ol className="conversation-messages" aria-label="Payment conversation">
      {conversation.turns.map((turn) => <li className="conversation-turn" key={turn.id}>
        <div className="message message-user"><span className="message-author">You</span><p>{turn.request}</p></div>
        {turn.reply && <div className="message message-assistant"><span className="message-author">HaPaPay</span><p>{turn.reply}</p>
          {onSuggestion && turn === lastTurn && turn.suggestions?.length ? <div className="message-suggestions" role="group" aria-label="Send one of these instead">
            {turn.suggestions.map((suggestion) => <button type="button" key={suggestion} disabled={busy} onClick={() => onSuggestion(suggestion)}>{suggestion}</button>)}
          </div> : null}
        </div>}
      </li>)}
    </ol>
    {conversation.pendingId !== undefined && <div className="message message-assistant message-pending" role="status">
      <span className="message-author">HaPaPay</span>
      <p><span className="pending-bird" aria-hidden="true"><BrandMark /></span> Preparing your draft</p>
    </div>}
    {showStatus && <div className="message message-assistant message-status" role="status">
      <span className="message-author">HaPaPay</span><p>{status}</p>
    </div>}
    <span className="conversation-announcement" role="status">{conversation.pendingId === undefined ? lastTurn?.reply : ""}</span>
  </div>;
}

/** Whether the desk's latest status is news: not a request being read, and not the last answer said again. */
function statusShown(conversation: Conversation, status: string) {
  return conversation.pendingId === undefined && Boolean(status) && status !== conversation.turns.at(-1)?.reply;
}

/**
 * The desk's latest status under the slips, right below the button that asked for it, and scrolled into view, so a
 * vault slip's refusal never sits above the slip out of sight while its button seems to do nothing.
 */
export function SlipStatus({ conversation, status }: { conversation: Conversation; status: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = statusShown(conversation, status);
  useEffect(() => {
    if (!shown) return;
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [shown, status]);
  if (!shown) return null;
  return <div className="payment-conversation slip-status" ref={ref}>
    <div className="message message-assistant message-status" role="status" aria-live="polite">
      <span className="message-author">HaPaPay</span><p>{status}</p>
    </div>
  </div>;
}
