import { useState, useRef, useCallback } from "react";

const CALL_TYPES = ["expired", "fsbo", "landlord", "renter", "circle", "past_client", "other"];

const CLAUDE_SYSTEM = `You are an elite real estate sales coach analyzing prospect call transcripts. The agent is Daniel Stewart at The Finest Homes in St. George, Utah, targeting expired listings, FSBOs, and nightly rental owners in the $500K–$1M+ range.

Analyze the transcript and return ONLY a valid JSON object — no markdown, no preamble, no explanation:
{
  "scores": {
    "rapport": <0-100>,
    "discovery": <0-100>,
    "objection_handling": <0-100>,
    "talk_ratio": <0-100>,
    "next_step": <0-100>,
    "overall": <0-100>
  },
  "talk_ratio_estimate": "<agent%> agent / <prospect%> prospect",
  "call_summary": "<2-3 sentence summary of what happened>",
  "wins": ["<specific win>", "<specific win>", "<specific win>"],
  "coaching_notes": [
    {"issue": "<specific issue>", "fix": "<exact replacement phrasing or technique to use>"},
    {"issue": "<specific issue>", "fix": "<exact replacement phrasing or technique to use>"},
    {"issue": "<specific issue>", "fix": "<exact replacement phrasing or technique to use>"}
  ],
  "best_moment": "<quote or description of best moment>",
  "missed_opportunity": "<the single biggest missed opportunity on this call>",
  "lead_temperature": "hot|warm|cold|dead",
  "recommended_followup": "<specific next action with timing and suggested script>",
  "key_motivations": ["<motivation>", "<motivation>"],
  "objections_detected": ["<objection>", "<objection>"],
  "appointment_set": <true|false>,
  "next_step_detail": "<what was agreed, or null>"
}

Scoring rubric:
- rapport: warmth, mirroring, active listening, empathy signals, natural flow
- discovery: open-ended questions, uncovering motivation/timeline/pain/price expectations
- objection_handling: acknowledging objections, reframing, not accepting them as final
- talk_ratio: score HIGH if agent talked LESS than 45%. Score LOW if agent dominated.
- next_step: was a specific, committed next step established? Vague "I'll be in touch" = 10/10.
- overall: weighted average with discovery and next_step weighted 2x

Be brutally honest. This agent wants to improve, not feel validated.`;

const SCORE_META = {
  rapport: { label: "Rapport", icon: "◎" },
  discovery: { label: "Discovery", icon: "◉" },
  objection_handling: { label: "Objections", icon: "◈" },
  talk_ratio: { label: "Talk Ratio", icon: "◑" },
  next_step: { label: "Next Step", icon: "◆" },
  overall: { label: "Overall", icon: "★" },
};

const scoreColor = (s) => s >= 80 ? "#4ade80" : s >= 60 ? "#fbbf24" : "#f87171";
const tempMeta = { hot: { color: "#f87171", label: "HOT" }, warm: { color: "#fbbf24", label: "WARM" }, cold: { color: "#60a5fa", label: "COLD" }, dead: { color: "#6b7280", label: "DEAD" } };

const STEPS = [
  { id: "upload", label: "Upload MP3" },
  { id: "transcribe", label: "Transcribing" },
  { id: "analyze", label: "Analyzing" },
  { id: "done", label: "Results" },
];

export default function CallAnalyzerFull() {
  const [assemblyKey, setAssemblyKey] = useState(() => localStorage.getItem("assemblyai_key") || "");
  const [showKey, setShowKey] = useState(false);
  const [file, setFile] = useState(null);
  const [contactName, setContactName] = useState("");
  const [callType, setCallType] = useState("expired");
  const [step, setStep] = useState("idle"); // idle | upload | transcribe | analyze | done | error
  const [progress, setProgress] = useState("");
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState("scores");
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const pollRef = useRef(null);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.includes("audio")) setFile(f);
  }, []);

  const reset = () => {
    setFile(null); setStep("idle"); setProgress(""); setTranscript("");
    setResult(null); setError(null); setActiveTab("scores");
    if (pollRef.current) clearTimeout(pollRef.current);
  };

  const runPipeline = async () => {
    if (!file || !assemblyKey) return;
    setError(null);
    setResult(null);

    try {
      // STEP 1: Upload to AssemblyAI
      setStep("upload");
      setProgress("Uploading audio to AssemblyAI...");
      const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: { authorization: assemblyKey, "content-type": "application/octet-stream" },
        body: file,
      });
      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status} — check your AssemblyAI API key`);
      const { upload_url } = await uploadRes.json();

      // STEP 2: Submit transcription
      setStep("transcribe");
      setProgress("Submitting for transcription + speaker diarization...");
      const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: assemblyKey, "content-type": "application/json" },
        body: JSON.stringify({ audio_url: upload_url, speaker_labels: true, punctuate: true, format_text: true }),
      });
      if (!transcriptRes.ok) throw new Error(`Transcription submit failed: ${transcriptRes.status}`);
      const { id: transcriptId } = await transcriptRes.json();

      // STEP 3: Poll for completion
      setProgress("Transcribing audio... (this takes 30–90 seconds)");
      const pollTranscript = async () => {
        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
          headers: { authorization: assemblyKey },
        });
        const data = await pollRes.json();

        if (data.status === "completed") {
          // Format diarized transcript
          let formatted = "";
          if (data.utterances?.length > 0) {
            formatted = data.utterances.map(u => `${u.speaker === "A" ? "Agent" : "Prospect"}: ${u.text}`).join("\n\n");
          } else {
            formatted = data.text || "";
          }
          setTranscript(formatted);
          return formatted;
        } else if (data.status === "error") {
          throw new Error(`Transcription error: ${data.error}`);
        } else {
          setProgress(`Transcribing... (status: ${data.status})`);
          await new Promise(r => { pollRef.current = setTimeout(r, 5000); });
          return pollTranscript();
        }
      };
      const finalTranscript = await pollTranscript();

      // STEP 4: Claude analysis
      setStep("analyze");
      setProgress("Running AI coaching analysis...");
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          system: CLAUDE_SYSTEM,
          messages: [{
            role: "user",
            content: `Call Type: ${callType}\nAgent: Daniel Stewart\nContact: ${contactName || "Unknown"}\nFile: ${file.name}\n\nTranscript:\n${finalTranscript}`
          }]
        }),
      });
      if (!claudeRes.ok) throw new Error(`Claude API failed: ${claudeRes.status}`);
      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.find(b => b.type === "text")?.text || "";
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setResult(parsed);
      setStep("done");
      setActiveTab("scores");

    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  const currentStepIndex = STEPS.findIndex(s => s.id === step);
  const isRunning = ["upload", "transcribe", "analyze"].includes(step);

  return (
    <div style={{ minHeight: "100vh", background: "#08090b", color: "#e2e8f0", fontFamily: "'DM Mono', 'Fira Code', 'Courier New', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-track { background: #08090b; } ::-webkit-scrollbar-thumb { background: #1e2330; }
        .pipeline-step { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
        .step-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .step-line { width: 1px; height: 20px; background: #1e2330; margin-left: 3.5px; }
        .tab { background: none; border: none; cursor: pointer; font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; padding: 8px 14px; transition: all .2s; border-bottom: 1px solid transparent; }
        .tab.on { color: #fbbf24; border-bottom-color: #fbbf24; }
        .tab.off { color: #374151; } .tab.off:hover { color: #6b7280; }
        .run-btn { background: #fbbf24; color: #08090b; border: none; cursor: pointer; font-family: 'DM Mono', monospace; font-weight: 500; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; padding: 13px 28px; transition: all .15s; }
        .run-btn:hover:not(:disabled) { background: #f59e0b; }
        .run-btn:disabled { opacity: .35; cursor: not-allowed; }
        .drop-zone { border: 1px dashed #1e2330; padding: 28px 20px; text-align: center; cursor: pointer; transition: all .2s; position: relative; }
        .drop-zone.over { border-color: #fbbf24; background: rgba(251,191,36,.04); }
        .drop-zone:hover { border-color: #374151; }
        .field-label { font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: #374151; margin-bottom: 6px; display: block; }
        .text-input { background: #0d0f14; border: 1px solid #1e2330; color: #e2e8f0; font-family: 'DM Mono', monospace; font-size: 12px; padding: 10px 12px; width: 100%; outline: none; transition: border-color .2s; }
        .text-input:focus { border-color: #374151; }
        select.text-input option { background: #0d0f14; }
        .score-row { margin-bottom: 12px; }
        .coaching-card { background: #0d0f14; border: 1px solid #1e2330; border-left: 2px solid #fbbf24; padding: 12px 14px; margin-bottom: 8px; }
        .win-pill { background: rgba(74,222,128,.07); border: 1px solid rgba(74,222,128,.2); color: #4ade80; font-size: 11px; padding: 5px 10px; margin-bottom: 6px; display: block; line-height: 1.4; }
        @keyframes pulse-dot { 0%,100% { opacity:1; } 50% { opacity:.3; } }
        .pulse { animation: pulse-dot 1.2s infinite; }
        @keyframes fadein { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        .fadein { animation: fadein .4s ease forwards; }
        .progress-bar { height: 2px; background: #fbbf24; transition: width 1s ease; }
        .key-input-wrap { position: relative; }
        .key-input-wrap input { padding-right: 60px !important; }
        .show-toggle { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 9px; letter-spacing: .1em; color: #374151; font-family: 'DM Mono', monospace; }
        .show-toggle:hover { color: #6b7280; }
      `}</style>

      {/* Header */}
      <div style={{ background: "#0a0c10", borderBottom: "1px solid #111318", padding: "14px 28px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 6, height: 6, background: "#fbbf24", borderRadius: "50%" }} />
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: ".06em", color: "#fbbf24" }}>CALL INTEL</span>
        <span style={{ fontSize: 9, color: "#1e2330", letterSpacing: ".1em", marginLeft: 4 }}>THE FINEST HOMES · ST. GEORGE UT</span>
        {step === "done" && (
          <button onClick={reset} style={{ marginLeft: "auto", background: "none", border: "1px solid #1e2330", cursor: "pointer", color: "#374151", fontSize: 9, letterSpacing: ".1em", fontFamily: "'DM Mono', monospace", padding: "4px 12px" }}>
            NEW CALL
          </button>
        )}
      </div>

      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "28px 20px", display: "grid", gridTemplateColumns: step === "done" ? "340px 1fr" : "1fr", gap: 24 }}>

        {/* LEFT / INPUT PANEL */}
        {step !== "done" && (
          <div style={{ maxWidth: 560, margin: "0 auto", width: "100%" }}>
            {/* API Key */}
            <div style={{ marginBottom: 20 }}>
              <span className="field-label">AssemblyAI API Key</span>
              <div className="key-input-wrap">
                <input
                  className="text-input"
                  type={showKey ? "text" : "password"}
                  placeholder="Enter your AssemblyAI key..."
                  value={assemblyKey}
                  onChange={e => { setAssemblyKey(e.target.value); localStorage.setItem("assemblyai_key", e.target.value); }}
                  style={{ width: "100%" }}
                />
                <button className="show-toggle" onClick={() => setShowKey(v => !v)}>
                  {showKey ? "HIDE" : "SHOW"}
                </button>
              </div>
              <div style={{ fontSize: 9, color: "#1e2330", marginTop: 4 }}>
                assemblyai.com → Account → API Keys · Free tier: 100 hrs/mo
              </div>
            </div>

            {/* Contact + Call Type */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div>
                <span className="field-label">Contact Name</span>
                <input className="text-input" placeholder="e.g. Tiffany Rogers" value={contactName} onChange={e => setContactName(e.target.value)} />
              </div>
              <div>
                <span className="field-label">Call Type</span>
                <select className="text-input" value={callType} onChange={e => setCallType(e.target.value)}>
                  {CALL_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1).replace("_", " ")}</option>)}
                </select>
              </div>
            </div>

            {/* Drop Zone */}
            <div style={{ marginBottom: 20 }}>
              <span className="field-label">MP3 Recording</span>
              <div
                className={`drop-zone ${dragging ? "over" : ""}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <input ref={fileRef} type="file" accept="audio/*,.mp3" style={{ display: "none" }} onChange={e => setFile(e.target.files[0])} />
                {file ? (
                  <div>
                    <div style={{ fontSize: 12, color: "#fbbf24", marginBottom: 4 }}>{file.name}</div>
                    <div style={{ fontSize: 10, color: "#374151" }}>{(file.size / 1024 / 1024).toFixed(1)} MB · click to replace</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 11, color: "#374151", marginBottom: 4 }}>Drop MP3 here or <span style={{ color: "#fbbf24" }}>browse</span></div>
                    <div style={{ fontSize: 9, color: "#1e2330" }}>Works with any Mojo Dialer recording download</div>
                  </div>
                )}
              </div>
            </div>

            {/* Pipeline preview */}
            <div style={{ background: "#0a0c10", border: "1px solid #111318", padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ fontSize: 9, color: "#1e2330", letterSpacing: ".14em", marginBottom: 10 }}>PIPELINE</div>
              {["Upload MP3 → AssemblyAI", "Speaker diarization (Agent / Prospect)", "Claude coaching analysis", "Scores + coaching notes + follow-up"].map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: i < 3 ? 8 : 0 }}>
                  <div style={{ width: 4, height: 4, background: "#1e2330", borderRadius: "50%", marginTop: 5, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: "#374151", lineHeight: 1.4 }}>{s}</span>
                </div>
              ))}
            </div>

            <button className="run-btn" onClick={runPipeline} disabled={!file || !assemblyKey || isRunning} style={{ width: "100%" }}>
              {isRunning ? "Processing..." : "Run Full Analysis"}
            </button>

            {/* Progress */}
            {isRunning && (
              <div style={{ marginTop: 20 }} className="fadein">
                {/* Step indicators */}
                <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "1px solid #111318" }}>
                  {STEPS.map((s, i) => {
                    const active = s.id === step;
                    const done = currentStepIndex > i;
                    return (
                      <div key={s.id} style={{ flex: 1, padding: "8px 0", textAlign: "center", borderBottom: `1px solid ${active ? "#fbbf24" : "transparent"}` }}>
                        <div style={{ fontSize: 9, letterSpacing: ".1em", color: active ? "#fbbf24" : done ? "#374151" : "#1e2330" }}>
                          {done ? "✓ " : active ? "· " : ""}{s.label.toUpperCase()}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: "#6b7280", display: "flex", alignItems: "center", gap: 8 }}>
                  <div className="pulse" style={{ width: 5, height: 5, background: "#fbbf24", borderRadius: "50%", flexShrink: 0 }} />
                  {progress}
                </div>
              </div>
            )}

            {/* Error */}
            {step === "error" && error && (
              <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(248,113,113,.06)", border: "1px solid rgba(248,113,113,.2)", fontSize: 11, color: "#f87171" }}>
                {error}
              </div>
            )}
          </div>
        )}

        {/* LEFT PANEL — Results Sidebar */}
        {step === "done" && result && (
          <div className="fadein">
            {/* Overall score */}
            <div style={{ background: "#0a0c10", border: `1px solid ${scoreColor(result.scores.overall)}30`, padding: "18px 16px", marginBottom: 16, textAlign: "center" }}>
              <div style={{ fontSize: 9, letterSpacing: ".16em", color: "#374151", marginBottom: 8 }}>OVERALL SCORE</div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 52, fontWeight: 800, color: scoreColor(result.scores.overall), lineHeight: 1 }}>
                {result.scores.overall}
              </div>
              <div style={{ fontSize: 9, color: "#374151", marginTop: 4 }}>out of 100</div>
            </div>

            {/* Lead temp */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#0a0c10", border: "1px solid #111318", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 9, color: "#1e2330", letterSpacing: ".14em", marginBottom: 3 }}>LEAD TEMP</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: tempMeta[result.lead_temperature]?.color || "#6b7280", fontFamily: "'Syne', sans-serif" }}>
                  {result.lead_temperature?.toUpperCase()}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 9, color: "#1e2330", letterSpacing: ".14em", marginBottom: 3 }}>APPT SET</div>
                <div style={{ fontSize: 13, color: result.appointment_set ? "#4ade80" : "#f87171", fontFamily: "'Syne', sans-serif" }}>
                  {result.appointment_set ? "YES" : "NO"}
                </div>
              </div>
            </div>

            {/* Talk ratio */}
            {result.talk_ratio_estimate && (
              <div style={{ padding: "8px 14px", background: "#0a0c10", border: "1px solid #111318", marginBottom: 16 }}>
                <div style={{ fontSize: 9, color: "#1e2330", letterSpacing: ".14em", marginBottom: 4 }}>TALK RATIO</div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>{result.talk_ratio_estimate}</div>
              </div>
            )}

            {/* Individual scores */}
            <div style={{ marginBottom: 16 }}>
              {Object.entries(result.scores).filter(([k]) => k !== "overall").map(([key, val]) => {
                const c = scoreColor(val);
                return (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: "#4b5563" }}>{SCORE_META[key]?.label}</span>
                      <span style={{ fontSize: 11, color: c, fontWeight: 500 }}>{val}</span>
                    </div>
                    <div style={{ height: 2, background: "#111318", borderRadius: 1 }}>
                      <div style={{ height: "100%", width: `${val}%`, background: c, borderRadius: 1, transition: "width 1s ease" }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* File info */}
            <div style={{ padding: "8px 14px", background: "#0a0c10", border: "1px solid #111318", fontSize: 10, color: "#1e2330" }}>
              {contactName || "Unknown"} · {callType} · {file?.name}
            </div>

            <button onClick={reset} style={{ marginTop: 12, width: "100%", background: "none", border: "1px solid #1e2330", color: "#374151", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 10, letterSpacing: ".1em", padding: "10px", transition: "all .2s" }}
              onMouseEnter={e => { e.target.style.borderColor = "#374151"; e.target.style.color = "#6b7280"; }}
              onMouseLeave={e => { e.target.style.borderColor = "#1e2330"; e.target.style.color = "#374151"; }}>
              ANALYZE ANOTHER CALL
            </button>
          </div>
        )}

        {/* RIGHT PANEL — Results Detail */}
        {step === "done" && result && (
          <div className="fadein">
            {/* Summary */}
            <div style={{ background: "#0a0c10", border: "1px solid #111318", padding: "14px 16px", marginBottom: 16 }}>
              <div className="field-label" style={{ marginBottom: 6 }}>Call Summary</div>
              <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6, fontFamily: "'Syne', sans-serif", fontWeight: 400 }}>
                {result.call_summary}
              </p>
            </div>

            {/* Tabs */}
            <div style={{ borderBottom: "1px solid #111318", marginBottom: 18, display: "flex" }}>
              {[["scores", "Coaching Notes"], ["wins", "Wins"], ["followup", "Follow-up"], ["transcript", "Transcript"]].map(([id, label]) => (
                <button key={id} className={`tab ${activeTab === id ? "on" : "off"}`} onClick={() => setActiveTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {/* COACHING NOTES */}
            {activeTab === "scores" && (
              <div className="fadein">
                {result.coaching_notes?.map((note, i) => (
                  <div key={i} className="coaching-card">
                    <div style={{ fontSize: 10, color: "#fbbf24", marginBottom: 6, letterSpacing: ".04em" }}>
                      ⚑ {note.issue}
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6, fontFamily: "'Syne', sans-serif" }}>
                      <span style={{ color: "#374151", fontSize: 9, letterSpacing: ".1em" }}>TRY INSTEAD: </span>
                      {note.fix}
                    </div>
                  </div>
                ))}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
                  {result.best_moment && (
                    <div style={{ background: "#0a0c10", border: "1px solid #111318", borderLeft: "2px solid #4ade80", padding: "12px 14px" }}>
                      <div style={{ fontSize: 9, color: "#4ade80", letterSpacing: ".14em", marginBottom: 6 }}>BEST MOMENT</div>
                      <p style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.5, fontFamily: "'Syne', sans-serif" }}>{result.best_moment}</p>
                    </div>
                  )}
                  {result.missed_opportunity && (
                    <div style={{ background: "#0a0c10", border: "1px solid #111318", borderLeft: "2px solid #f87171", padding: "12px 14px" }}>
                      <div style={{ fontSize: 9, color: "#f87171", letterSpacing: ".14em", marginBottom: 6 }}>MISSED OPPORTUNITY</div>
                      <p style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.5, fontFamily: "'Syne', sans-serif" }}>{result.missed_opportunity}</p>
                    </div>
                  )}
                </div>

                {result.objections_detected?.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div className="field-label">Objections Detected</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {result.objections_detected.map((o, i) => (
                        <span key={i} style={{ fontSize: 10, color: "#f87171", background: "rgba(248,113,113,.07)", border: "1px solid rgba(248,113,113,.2)", padding: "4px 10px" }}>{o}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* WINS */}
            {activeTab === "wins" && (
              <div className="fadein">
                <div className="field-label" style={{ marginBottom: 10 }}>What Worked</div>
                {result.wins?.map((w, i) => <span key={i} className="win-pill">{w}</span>)}

                {result.key_motivations?.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <div className="field-label">Key Motivations Detected</div>
                    {result.key_motivations.map((m, i) => (
                      <div key={i} style={{ padding: "8px 12px", background: "#0a0c10", border: "1px solid #111318", marginBottom: 6, fontSize: 11, color: "#6b7280", fontFamily: "'Syne', sans-serif" }}>
                        {m}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* FOLLOW-UP */}
            {activeTab === "followup" && (
              <div className="fadein">
                <div className="field-label">Recommended Next Action</div>
                <div style={{ background: "#0a0c10", border: "1px solid #fbbf2420", borderLeft: "2px solid #fbbf24", padding: "14px 16px", marginBottom: 20 }}>
                  <p style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.7, fontFamily: "'Syne', sans-serif" }}>
                    {result.recommended_followup}
                  </p>
                </div>

                {result.next_step_detail && result.appointment_set && (
                  <div style={{ background: "#0a0c10", border: "1px solid #4ade8020", padding: "10px 14px", marginBottom: 16 }}>
                    <div style={{ fontSize: 9, color: "#4ade80", letterSpacing: ".14em", marginBottom: 4 }}>APPOINTMENT DETAIL</div>
                    <p style={{ fontSize: 11, color: "#6b7280", fontFamily: "'Syne', sans-serif" }}>{result.next_step_detail}</p>
                  </div>
                )}

                <div style={{ padding: "12px 14px", background: "#0a0c10", border: "1px solid #111318" }}>
                  <div className="field-label">GHL Integration</div>
                  <div style={{ fontSize: 10, color: "#1e2330", lineHeight: 1.7, fontFamily: "'Syne', sans-serif" }}>
                    To auto-push this analysis to GoHighLevel, run the N8N workflow with contact_id and the MP3 URL. The workflow will add the full scorecard as a contact note and tag hot leads automatically.
                  </div>
                </div>
              </div>
            )}

            {/* TRANSCRIPT */}
            {activeTab === "transcript" && (
              <div className="fadein">
                <div className="field-label">Diarized Transcript</div>
                <div style={{ background: "#0a0c10", border: "1px solid #111318", padding: "14px 16px", maxHeight: 420, overflowY: "auto" }}>
                  {transcript ? transcript.split("\n\n").map((line, i) => {
                    const isAgent = line.startsWith("Agent:");
                    return (
                      <div key={i} style={{ marginBottom: 12 }}>
                        <span style={{ fontSize: 9, letterSpacing: ".12em", color: isAgent ? "#fbbf24" : "#60a5fa" }}>
                          {isAgent ? "AGENT" : "PROSPECT"}
                        </span>
                        <p style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5, marginTop: 3, fontFamily: "'Syne', sans-serif" }}>
                          {line.replace(/^(Agent:|Prospect:)\s*/, "")}
                        </p>
                      </div>
                    );
                  }) : <p style={{ fontSize: 11, color: "#1e2330" }}>Transcript not available</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
