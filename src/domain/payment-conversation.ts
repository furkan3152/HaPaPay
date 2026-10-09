export type PaymentConversationTurn = { id: number; request: string; reply?: string; suggestions?: string[] };
export type PaymentConversation = { turns: PaymentConversationTurn[]; pendingId?: number };
export type PaymentConversationAction =
  | { type: "request"; id: number; message: string }
  | { type: "reply" | "cancel"; id: number; message: string; suggestions?: string[] }
  | { type: "clear" };

export const emptyPaymentConversation: PaymentConversation = { turns: [] };

/** Local, text-only context. Payment authorization stays outside the transcript. */
export function paymentConversationReducer(state: PaymentConversation, action: PaymentConversationAction): PaymentConversation {
  if (action.type === "clear") return state.pendingId === undefined ? { turns: [] } : state;
  if (action.type === "request") {
    return { turns: [...state.turns.slice(-9), { id: action.id, request: action.message }], pendingId: action.id };
  }
  if (state.pendingId !== action.id) return state;
  const suggestions = action.type === "reply" && action.suggestions?.length ? { suggestions: action.suggestions } : {};
  return {
    turns: state.turns.map((turn) => turn.id === action.id ? { ...turn, reply: action.message, ...suggestions } : turn),
  };
}
