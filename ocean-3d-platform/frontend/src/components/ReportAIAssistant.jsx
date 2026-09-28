/* ============================================================
   REPORT AI ASSISTANT (additive feature)

   Compact chat panel embedded in the Report Analysis view.
   Grounded ONLY in the open report's computed values; the field
   names below mirror the actual shapes produced by
   demoData.js::getReport*Analysis (audit Q18). The backend
   system prompt forbids inventing values not present in the
   context; null fields are never sent.
============================================================ */

import { useEffect, useRef, useState } from "react";

const QUICK_ACTIONS = [
  { label: "Summarize", prompt: "Summarize this report in 3-4 sentences." },
  { label: "Temperature", prompt: "What does the temperature data in this report show?" },
  { label: "Depth Analysis", prompt: "Explain the depth selection and what it means for this report." },
  { label: "Key Findings", prompt: "What are the most important findings in this report?" },
  { label: "Statistics", prompt: "Explain the statistics in this report in plain language." },
  { label: "Present This", prompt: "Give me a short presentation-ready summary of this report." },
];

function buildReportContext(report) {
  if (!report) return {};
  /* Report Analysis object shapes (audit Q18):
       temp/sal/curr/chl: { current, min, max, mean, observationCount, unit, ... } */
  const variableStats = (entry) => {
    if (!entry) return null;
    return {
      current: entry.current ?? null,
      min: entry.min ?? null,
      max: entry.max ?? null,
      mean: entry.mean ?? null,
      observation_count: entry.observationCount ?? null,
      unit: entry.unit ?? null,
    };
  };

  return {
    title: report.title ?? "RATNAKARA Ocean Report",
    region: report.region ?? null,
    location: report.location ?? null,
    analysis_date: report.analysisDate ?? null,
    depth_label: report.depthLabel ?? null,
    data_source: report.dataSource ?? null,
    variables: {
      temperature: variableStats(report.temp),
      salinity: variableStats(report.sal),
      currents: variableStats(report.curr),
      chlorophyll: variableStats(report.chl),
    },
  };
}

export default function ReportAIAssistant({ report, lightMode = false, onClose }) {
  const [messages, setMessages] = useState([]); // {role, content}
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef(null);

  /* Report identity: the view is regenerated whenever its center
     coordinates or depth change, so those act as the identifier. */
  const reportKey = report
    ? `${report.center?.latitude ?? "?"},${report.center?.longitude ?? "?"}:${report.depthLabel ?? "?"}`
    : "none";

  /* Clear the conversation when the report changes — adjusted during
     render (React "storing information from previous renders" pattern)
     instead of an effect, so no cascading render occurs. */
  const [prevReportKey, setPrevReportKey] = useState(reportKey);
  if (prevReportKey !== reportKey) {
    setPrevReportKey(reportKey);
    setMessages([]);
    setInput("");
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isLoading]);

  async function sendMessage(question) {
    const trimmed = (question ?? "").trim();
    if (!trimmed || isLoading || !report) return;

    const userMessage = { role: "user", content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      /* Keep the last 6 turns as context; the current question is
         already sent separately, so exclude it from the history. */
      const historyToSend = updatedMessages.slice(-7, -1).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch("/api/v1/chat/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          report_context: buildReportContext(report),
          conversation_history: historyToSend,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.response },
      ]);
    } catch (err) {
      console.error("Report AI Assistant error:", err);
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
  const borderColor = lightMode
    ? "rgba(22, 135, 201, 0.20)"
    : "rgba(148, 163, 184, 0.18)";
  const accentColor = lightMode ? "#087e8b" : "#7dd3fc";
  const errorColor = "#f87171";

  if (!report) {
    return (
      <section className="report-panel" style={{ borderColor }}>
        <h2 className="report-panel-title">🤖 REPORT AI ASSISTANT</h2>
        <div style={{ fontSize: 11, color: mutedColor }}>
          No report selected. Please open a report to use the AI Assistant.
        </div>
      </section>
    );
  }

  return (
    <section
      className="report-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        padding: 0,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: `1px solid ${borderColor}`,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "1px" }}>
          🤖 REPORT AI ASSISTANT
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AI assistant"
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

      {/* Quick actions */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: "10px 16px",
          borderBottom: `1px solid ${borderColor}`,
        }}
      >
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={isLoading}
            onClick={() => sendMessage(action.prompt)}
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.5px",
              padding: "4px 9px",
              borderRadius: 8,
              border: `1px solid ${borderColor}`,
              background: "transparent",
              color: accentColor,
              cursor: isLoading ? "not-allowed" : "pointer",
            }}
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          maxHeight: 340,
          overflowY: "auto",
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 120,
        }}
      >
        {messages.length === 0 && !isLoading && (
          <div style={{ fontSize: 11, color: mutedColor }}>
            Ask anything about this report — answers are grounded in its data only.
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            style={{
              alignSelf: message.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "90%",
              padding: "8px 11px",
              borderRadius: 10,
              fontSize: 11,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              background:
                message.role === "user"
                  ? lightMode
                    ? "rgba(8, 126, 139, 0.12)"
                    : "rgba(59, 130, 246, 0.14)"
                  : "transparent",
              border: `1px solid ${borderColor}`,
              color: message.isError ? errorColor : textColor,
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
          padding: "10px 16px",
          borderTop: `1px solid ${borderColor}`,
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") sendMessage(input);
          }}
          placeholder="Ask about this report…"
          style={{
            flex: 1,
            fontSize: 11,
            padding: "8px 11px",
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
            padding: "8px 13px",
            borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: lightMode ? "rgba(8, 126, 139, 0.12)" : "rgba(59, 130, 246, 0.14)",
            color: accentColor,
            cursor: isLoading || !input.trim() ? "not-allowed" : "pointer",
            opacity: isLoading || !input.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </section>
  );
}
