/* ============================================================
   ASK THE OCEAN — chat panel (additive fix)

   Audit finding: the dashboard had only a disabled placeholder
   button; no chat UI existed, so the already-working
   POST /api/v1/chat route (services/api.ts::fetchChat) was never
   called. This panel is the minimum fix: a chat surface that
   sends the user's question plus the app's real current state as
   ChatContext. No backend changes, no new service layer.
============================================================ */

import { useEffect, useRef, useState } from "react";
import { fetchChat } from "../services/api";

/* Rebuilt each send from the current app state so the AI always sees the
   live view: variable, requested vs actual model depth, data source, and
   camera region. The backend uses this to ground answers (Part 12.6). */
function buildRichContext({ activeLayer, depth, actualModelDepth, dataSourceStatus, cameraReadout }) {
  const context = {};
  if (activeLayer) context.variable = String(activeLayer).toLowerCase();
  if (typeof depth === "number") context.depth = depth;
  if (
    typeof actualModelDepth === "number" &&
    Number.isFinite(actualModelDepth) &&
    actualModelDepth > 0
  ) {
    context.actual_model_depth = Math.round(actualModelDepth * 100) / 100;
  }
  if (dataSourceStatus === "real" || dataSourceStatus === "demo") {
    context.data_source =
      dataSourceStatus === "real" ? "REAL MODEL DATA" : "DEMO DATA";
  }
  if (cameraReadout && Number.isFinite(cameraReadout.lat) && Number.isFinite(cameraReadout.lon)) {
    const lat = cameraReadout.lat;
    const lon = cameraReadout.lon;
    context.region =
      lat < 3 || lat > 30 || lon < 45 || lon > 100
        ? "Indian Ocean region"
        : lon < 80
          ? "Arabian Sea"
          : "Bay of Bengal";
  }
  return context;
}

const QUICK_PROMPTS = [
  "What does the temperature layer show?",
  "Explain the selected depth level.",
  "What is the thermocline?",
  "Summarize the current ocean view.",
];

export default function AskTheOceanPanel({
  lightMode = false,
  activeLayer,
  depth,
  actualModelDepth,
  dataSourceStatus = "probing",
  cameraReadout = null,
  onClose,
}) {
  const [messages, setMessages] = useState([]); // {role, content}
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isLoading]);

  function buildChatContext() {
    // Structured context from live app state. Keys outside the backend
    // ChatContext schema (actual_model_depth, data_source) are dropped by
    // Pydantic — they are belt-and-braces and mentioned in the Final Report.
    return buildRichContext({
      activeLayer,
      depth,
      actualModelDepth,
      dataSourceStatus,
      cameraReadout,
    });
  }

  async function sendMessage(question) {
    const trimmed = (question ?? "").trim();
    if (!trimmed || isLoading) return;

    const userMessage = { role: "user", content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      /* Multi-turn context: last 6 prior turns, current question excluded
         (sent separately as `question`). Mirrors ReportAIAssistant. */
      const historyToSend = updatedMessages.slice(-7, -1).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const data = await fetchChat({
        question: trimmed,
        context: buildChatContext(),
        conversation_history: historyToSend,
      });
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
    } catch (err) {
      console.error("Ask the Ocean error:", err);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "AI Assistant is temporarily unavailable.",
          isError: true,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  const textColor = lightMode ? "#163743" : "#e2e8f0";
  const mutedColor = lightMode ? "#63818b" : "#94a3b8";
  const bg = lightMode ? "rgba(248, 253, 255, 0.96)" : "rgba(10, 18, 32, 0.96)";
  const borderColor = lightMode
    ? "rgba(22, 135, 201, 0.20)"
    : "rgba(148, 163, 184, 0.18)";
  const accentColor = lightMode ? "#087e8b" : "#7dd3fc";

  return (
    <div
      style={{
        position: "fixed",
        left: 280, /* right of the 264px-wide dashboard panel */
        bottom: 90,
        width: 320,
        maxHeight: "62vh",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
        background: bg,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        color: textColor,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 14px",
          borderBottom: `1px solid ${borderColor}`,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.6px" }}>
          💬 Ask the Ocean
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Ask the Ocean"
          style={{
            background: "none",
            border: "none",
            color: mutedColor,
            fontSize: 16,
            cursor: "pointer",
            padding: "0 2px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Quick prompts */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: "10px 14px",
          borderBottom: `1px solid ${borderColor}`,
        }}
      >
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={isLoading}
            onClick={() => sendMessage(prompt)}
            style={{
              fontSize: 9,
              padding: "3px 8px",
              borderRadius: 8,
              border: `1px solid ${borderColor}`,
              background: "transparent",
              color: accentColor,
              cursor: isLoading ? "not-allowed" : "pointer",
            }}
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 120,
        }}
      >
        {messages.length === 0 && !isLoading && (
          <div style={{ fontSize: 10, color: mutedColor }}>
            Ask anything about ocean science or the data currently on the globe.
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            style={{
              alignSelf: message.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              padding: "7px 10px",
              borderRadius: 10,
              fontSize: 11,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              background:
                message.role === "user"
                  ? lightMode
                    ? "rgba(8, 126, 139, 0.12)"
                    : "rgba(59, 130, 246, 0.16)"
                  : "transparent",
              border: `1px solid ${borderColor}`,
              color: message.role === "assistant" && message.isError ? "#f87171" : textColor,
            }}
          >
            {message.role === "user" ? `You: ${message.content}` : `AI: ${message.content}`}
          </div>
        ))}
        {isLoading && (
          <div style={{ fontSize: 10, color: mutedColor, fontStyle: "italic" }}>
            AI is thinking…
          </div>
        )}
      </div>

      {/* Input row */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 14px",
          borderTop: `1px solid ${borderColor}`,
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") sendMessage(input);
          }}
          placeholder="Ask about the ocean…"
          style={{
            flex: 1,
            fontSize: 11,
            padding: "7px 10px",
            borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: "transparent",
            color: textColor,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => sendMessage(input)}
          disabled={isLoading || !input.trim()}
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "7px 12px",
            borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: lightMode ? "rgba(8, 126, 139, 0.12)" : "rgba(59, 130, 246, 0.16)",
            color: accentColor,
            cursor: isLoading || !input.trim() ? "not-allowed" : "pointer",
            opacity: isLoading || !input.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
