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

const MILESTONE_SYSTEM = `You are an elite real estate sales coach providing a milestone performance review for Daniel Stewart at The Finest Homes in St. George, Utah. You are reviewing a batch of his last 10 analyzed calls.

You will receive aggregated data from those 10 calls including: average scores, all objections detected, all coaching notes, all missed opportunities, lead temperatures, and appointment set rates.

Return ONLY a valid JSON object — no markdown, no preamble:
{
  "headline": "<one bold sentence summarizing his last 10 calls>",
  "score_trend": "<improving | steady | declining — based on the score data>",
  "avg_overall": <number>,
  "strongest_skill": "<which of the 5 scoring categories he's best at>",
  "weakest_skill": "<which of the 5 scoring categories needs the most work>",
  "recurring_objections": [
    {"objection": "<the objection>", "frequency": <how many of 10 calls>, "script": "<exact word-for-word script to handle this objection next time>"}
  ],
  "missing_questions": [
    "<specific discovery question he should be asking but isn't — with exact phrasing>",
    "<specific discovery question he should be asking but isn't — with exact phrasing>",
    "<specific discovery question he should be asking but isn't — with exact phrasing>"
  ],
  "talk_ratio_assessment": "<analysis of his talk ratio pattern across 10 calls>",
  "pattern_alert": "<the single most important pattern you see across these calls that he needs to fix>",
  "drill_scripts": [
    {"scenario": "<specific scenario he keeps encountering>", "opening": "<exact opening line to use>", "key_phrases": ["<phrase 1>", "<phrase 2>", "<phrase 3>"], "close": "<exact closing/next-step line>"},
    {"scenario": "<specific scenario he keeps encountering>", "opening": "<exact opening line to use>", "key_phrases": ["<phrase 1>", "<phrase 2>", "<phrase 3>"], "close": "<exact closing/next-step line>"}
  ],
  "appointment_rate": "<X out of 10 calls resulted in appointments>",
  "next_10_focus": "<the ONE thing to focus on for the next 10 calls>"
}

Be specific. Use exact scripts and phrasing. Reference the Mashore Method where applicable. This agent is hungry to level up.`;

const SCORE_META = {
  rapport: { label: "Rapport", icon: "◎" },
  discovery: { label: "Discovery", icon: "◉" },
  objection_handling: { label: "Objections", icon: "◈" },
  talk_ratio: { label: "Talk Ratio", icon: "◑" },
  next_step: { label: "Next Step", icon: "◆" },
  overall: { label: "Overall", icon: "★" },
};

const scoreColor = (s) => s >= 80 ? "#16a34a" : s >= 60 ? "#ca8a04" : "#dc2626";
const tempMeta = { hot: { color: "#dc2626", label: "HOT" }, warm: { color: "#ca8a04", label: "WARM" }, cold: { color: "#2563eb", label: "COLD" }, dead: { color: "#6b7280", label: "DEAD" } };

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
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("call_history") || "[]"); } catch { return []; }
  });
  const [milestoneReport, setMilestoneReport] = useState(null);
  const [milestoneLoading, setMilestoneLoading] = useState(false);
  const [showMilestone, setShowMilestone] = useState(false);
  const fileRef = useRef();
  const pollRef = useRef(null);

  const generateMilestoneReport = async (calls) => {
    setMilestoneLoading(true);
    try {
      const last10 = calls.slice(0, 10);
      const allScores = last10.map(c => c.result?.scores).filter(Boolean);
      const avgScores = {};
      ["rapport", "discovery", "objection_handling", "talk_ratio", "next_step", "overall"].forEach(k => {
        const vals = allScores.map(s => s[k]).filter(v => typeof v === "number");
        avgScores[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
      });
      const allObjections = last10.flatMap(c => c.result?.objections_detected || []);
      const allCoachingNotes = last10.flatMap(c => (c.result?.coaching_notes || []).map(n => n.issue));
      const allMissedOpps = last10.map(c => c.result?.missed_opportunity).filter(Boolean);
      const temps = last10.map(c => c.result?.lead_temperature).filter(Boolean);
      const appts = last10.filter(c => c.result?.appointment_set).length;
      const callTypes = last10.map(c => c.callType).filter(Boolean);

      const summary = {
        avg_scores: avgScores,
        all_objections: allObjections,
        all_coaching_issues: allCoachingNotes,
        all_missed_opportunities: allMissedOpps,
        lead_temps: temps,
        appointments_set: appts,
        call_types: callTypes,
        individual_overalls: allScores.map(s => s.overall),
      };

      const res = await fetch("/.netlify/functions/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: MILESTONE_SYSTEM,
          messages: [{ role: "user", content: `Here is the aggregated data from my last 10 calls:\n\n${JSON.stringify(summary, null, 2)}` }]
        }),
      });
      if (!res.ok) throw new Error("Milestone report failed");
      const data = await res.json();
      const rawText = data.content?.find(b => b.type === "text")?.text || "";
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setMilestoneReport(parsed);
      setShowMilestone(true);
    } catch (err) {
      console.error("Milestone report error:", err);
    } finally {
      setMilestoneLoading(false);
    }
  };

  const saveToHistory = (res, trans, name, type, fileName) => {
    const entry = { id: Date.now(), date: new Date().toISOString(), contactName: name, callType: type, fileName, result: res, transcript: trans };
    const updated = [entry, ...history];
    setHistory(updated);
    localStorage.setItem("call_history", JSON.stringify(updated));
    if (updated.length > 0 && updated.length % 10 === 0) {
      generateMilestoneReport(updated);
    }
  };

  const deleteFromHistory = (id) => {
    const updated = history.filter(h => h.id !== id);
    setHistory(updated);
    localStorage.setItem("call_history", JSON.stringify(updated));
  };

  const loadFromHistory = (entry) => {
    setResult(entry.result);
    setTranscript(entry.transcript);
    setContactName(entry.contactName);
    setCallType(entry.callType);
    setStep("done");
    setActiveTab("scores");
    setShowHistory(false);
  };

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
      const uploadRes = await fetch("/.netlify/functions/upload", {
        method: "POST",
        headers: { "x-api-key": assemblyKey },
        body: file,
      });
      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status} — check your AssemblyAI API key`);
      const { upload_url } = await uploadRes.json();

      // STEP 2: Submit transcription
      setStep("transcribe");
      setProgress("Submitting for transcription + speaker diarization...");
      const transcriptRes = await fetch("/.netlify/functions/transcribe", {
        method: "POST",
        headers: { "x-api-key": assemblyKey, "content-type": "application/json" },
        body: JSON.stringify({ audio_url: upload_url, speaker_labels: true, punctuate: true, format_text: true, speech_models: ["universal-2"] }),
      });
      if (!transcriptRes.ok) throw new Error(`Transcription submit failed: ${transcriptRes.status}`);
      const { id: transcriptId } = await transcriptRes.json();

      // STEP 3: Poll for completion
      setProgress("Transcribing audio... (this takes 30–90 seconds)");
      const pollTranscript = async () => {
        const pollRes = await fetch(`/.netlify/functions/poll?id=${transcriptId}`, {
          headers: { "x-api-key": assemblyKey },
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
      const claudeRes = await fetch("/.netlify/functions/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      saveToHistory(parsed, finalTranscript, contactName, callType, file.name);
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
    <div style={{ minHeight: "100vh", background: "#f8f9fb", color: "#1e293b", fontFamily: "'DM Mono', 'Fira Code', 'Courier New', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #f0f1f3; } ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
        .pipeline-step { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
        .step-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .step-line { width: 1px; height: 20px; background: #e2e8f0; margin-left: 4.5px; }
        .tab { background: none; border: none; cursor: pointer; font-family: 'DM Mono', monospace; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; padding: 10px 18px; transition: all .2s; border-bottom: 2px solid transparent; }
        .tab.on { color: #b45309; border-bottom-color: #b45309; font-weight: 500; }
        .tab.off { color: #94a3b8; } .tab.off:hover { color: #475569; }
        .run-btn { background: #b45309; color: #fff; border: none; cursor: pointer; font-family: 'DM Mono', monospace; font-weight: 600; font-size: 15px; letter-spacing: .1em; text-transform: uppercase; padding: 16px 32px; border-radius: 6px; transition: all .15s; }
        .run-btn:hover:not(:disabled) { background: #92400e; }
        .run-btn:disabled { opacity: .35; cursor: not-allowed; }
        .drop-zone { border: 2px dashed #cbd5e1; padding: 32px 24px; text-align: center; cursor: pointer; transition: all .2s; position: relative; border-radius: 8px; background: #fff; }
        .drop-zone.over { border-color: #b45309; background: rgba(180,83,9,.04); }
        .drop-zone:hover { border-color: #94a3b8; }
        .field-label { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; margin-bottom: 8px; display: block; font-weight: 500; }
        .text-input { background: #fff; border: 1px solid #e2e8f0; color: #1e293b; font-family: 'DM Mono', monospace; font-size: 15px; padding: 12px 14px; width: 100%; outline: none; transition: border-color .2s; border-radius: 6px; }
        .text-input:focus { border-color: #94a3b8; box-shadow: 0 0 0 3px rgba(148,163,184,.15); }
        select.text-input option { background: #fff; }
        .score-row { margin-bottom: 14px; }
        .coaching-card { background: #fff; border: 1px solid #e2e8f0; border-left: 3px solid #b45309; padding: 16px 18px; margin-bottom: 10px; border-radius: 6px; }
        .win-pill { background: rgba(22,163,74,.06); border: 1px solid rgba(22,163,74,.25); color: #16a34a; font-size: 14px; padding: 8px 14px; margin-bottom: 8px; display: block; line-height: 1.5; border-radius: 6px; }
        @keyframes pulse-dot { 0%,100% { opacity:1; } 50% { opacity:.3; } }
        .pulse { animation: pulse-dot 1.2s infinite; }
        @keyframes fadein { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        .fadein { animation: fadein .4s ease forwards; }
        .progress-bar { height: 3px; background: #b45309; transition: width 1s ease; border-radius: 2px; }
        .key-input-wrap { position: relative; }
        .key-input-wrap input { padding-right: 60px !important; }
        .show-toggle { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 11px; letter-spacing: .1em; color: #94a3b8; font-family: 'DM Mono', monospace; }
        .show-toggle:hover { color: #475569; }
      `}</style>

      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "16px 28px", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 8, height: 8, background: "#b45309", borderRadius: "50%" }} />
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: ".04em", color: "#b45309" }}>CALL INTEL</span>
        <span style={{ fontSize: 12, color: "#94a3b8", letterSpacing: ".08em", marginLeft: 4 }}>THE FINEST HOMES · ST. GEORGE UT</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {history.length >= 10 && (
            <button onClick={() => { generateMilestoneReport(history); }} disabled={milestoneLoading}
              style={{ background: milestoneLoading ? "none" : "rgba(180,83,9,.08)", border: "1px solid #b45309", cursor: milestoneLoading ? "wait" : "pointer", color: "#b45309", fontSize: 12, letterSpacing: ".08em", fontFamily: "'DM Mono', monospace", padding: "6px 14px", borderRadius: 4, fontWeight: 600 }}>
              {milestoneLoading ? "GENERATING..." : "10-CALL REPORT"}
            </button>
          )}
          <button onClick={() => { setShowHistory(v => !v); setShowMilestone(false); if (step === "done") reset(); }} style={{ background: "none", border: "1px solid #e2e8f0", cursor: "pointer", color: showHistory ? "#b45309" : "#64748b", fontSize: 12, letterSpacing: ".08em", fontFamily: "'DM Mono', monospace", padding: "6px 14px", borderRadius: 4 }}>
            HISTORY{history.length > 0 ? ` (${history.length})` : ""}
          </button>
          {step === "done" && (
            <button onClick={reset} style={{ background: "none", border: "1px solid #e2e8f0", cursor: "pointer", color: "#64748b", fontSize: 12, letterSpacing: ".08em", fontFamily: "'DM Mono', monospace", padding: "6px 14px", borderRadius: 4 }}>
              NEW CALL
            </button>
          )}
        </div>
      </div>

      {/* Milestone Report Modal */}
      {showMilestone && milestoneReport && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setShowMilestone(false)}>
          <div style={{ background: "#f8f9fb", borderRadius: 12, maxWidth: 720, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: "32px 28px" }}
            onClick={e => e.stopPropagation()} className="fadein">

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: ".12em", color: "#b45309", fontWeight: 600, marginBottom: 4 }}>10-CALL MILESTONE REPORT</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 700, color: "#1e293b", lineHeight: 1.3 }}>{milestoneReport.headline}</div>
              </div>
              <button onClick={() => setShowMilestone(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#94a3b8", padding: 4 }}>✕</button>
            </div>

            {/* Top stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "14px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".1em", marginBottom: 6, fontWeight: 500 }}>AVG SCORE</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 28, fontWeight: 800, color: scoreColor(milestoneReport.avg_overall || 0) }}>{milestoneReport.avg_overall}</div>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "14px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".1em", marginBottom: 6, fontWeight: 500 }}>TREND</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: milestoneReport.score_trend === "improving" ? "#16a34a" : milestoneReport.score_trend === "declining" ? "#dc2626" : "#ca8a04" }}>
                  {milestoneReport.score_trend === "improving" ? "IMPROVING" : milestoneReport.score_trend === "declining" ? "DECLINING" : "STEADY"}
                </div>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "14px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".1em", marginBottom: 6, fontWeight: 500 }}>APPTS SET</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 700, color: "#1e293b" }}>{milestoneReport.appointment_rate}</div>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "14px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".1em", marginBottom: 6, fontWeight: 500 }}>WEAKEST</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 14, fontWeight: 700, color: "#dc2626" }}>{milestoneReport.weakest_skill?.replace("_", " ").toUpperCase()}</div>
              </div>
            </div>

            {/* Pattern Alert */}
            <div style={{ background: "rgba(180,83,9,.06)", border: "1px solid rgba(180,83,9,.25)", borderLeft: "4px solid #b45309", padding: "16px 18px", marginBottom: 20, borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#b45309", letterSpacing: ".1em", marginBottom: 6, fontWeight: 600 }}>PATTERN ALERT</div>
              <p style={{ fontSize: 15, color: "#334155", lineHeight: 1.7, fontFamily: "'Syne', sans-serif" }}>{milestoneReport.pattern_alert}</p>
            </div>

            {/* Talk ratio assessment */}
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "14px 18px", marginBottom: 20, borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".1em", marginBottom: 6, fontWeight: 500 }}>TALK RATIO PATTERN</div>
              <p style={{ fontSize: 14, color: "#475569", lineHeight: 1.6, fontFamily: "'Syne', sans-serif" }}>{milestoneReport.talk_ratio_assessment}</p>
            </div>

            {/* Recurring Objections + Scripts */}
            {milestoneReport.recurring_objections?.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#64748b", marginBottom: 12, fontWeight: 500 }}>RECURRING OBJECTIONS + SCRIPTS</div>
                {milestoneReport.recurring_objections.map((obj, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: "3px solid #dc2626", padding: "14px 18px", marginBottom: 10, borderRadius: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: "#dc2626", fontWeight: 600 }}>{obj.objection}</span>
                      <span style={{ fontSize: 11, color: "#94a3b8", background: "#f1f5f9", padding: "2px 8px", borderRadius: 4 }}>{obj.frequency}/10 calls</span>
                    </div>
                    <div style={{ background: "#f8f9fb", border: "1px solid #e2e8f0", borderRadius: 6, padding: "12px 14px" }}>
                      <div style={{ fontSize: 11, color: "#b45309", letterSpacing: ".08em", marginBottom: 6, fontWeight: 600 }}>YOUR SCRIPT:</div>
                      <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.7, fontFamily: "'Syne', sans-serif", fontStyle: "italic" }}>"{obj.script}"</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Missing Questions */}
            {milestoneReport.missing_questions?.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#64748b", marginBottom: 12, fontWeight: 500 }}>QUESTIONS YOU SHOULD BE ASKING</div>
                {milestoneReport.missing_questions.map((q, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: "3px solid #2563eb", padding: "12px 16px", marginBottom: 8, borderRadius: 6 }}>
                    <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.6, fontFamily: "'Syne', sans-serif", fontStyle: "italic" }}>"{q}"</p>
                  </div>
                ))}
              </div>
            )}

            {/* Drill Scripts */}
            {milestoneReport.drill_scripts?.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#64748b", marginBottom: 12, fontWeight: 500 }}>DRILL SCRIPTS — PRACTICE THESE</div>
                {milestoneReport.drill_scripts.map((drill, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "18px 20px", marginBottom: 12, borderRadius: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#b45309", marginBottom: 12, fontFamily: "'Syne', sans-serif" }}>{drill.scenario}</div>
                    <div style={{ marginBottom: 10 }}>
                      <span style={{ fontSize: 11, color: "#16a34a", letterSpacing: ".08em", fontWeight: 600 }}>OPENING: </span>
                      <span style={{ fontSize: 14, color: "#334155", fontFamily: "'Syne', sans-serif", fontStyle: "italic" }}>"{drill.opening}"</span>
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <span style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".08em", fontWeight: 500 }}>KEY PHRASES: </span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                        {drill.key_phrases?.map((p, j) => (
                          <span key={j} style={{ fontSize: 13, background: "rgba(180,83,9,.06)", border: "1px solid rgba(180,83,9,.2)", color: "#92400e", padding: "4px 10px", borderRadius: 4 }}>"{p}"</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span style={{ fontSize: 11, color: "#2563eb", letterSpacing: ".08em", fontWeight: 600 }}>CLOSE: </span>
                      <span style={{ fontSize: 14, color: "#334155", fontFamily: "'Syne', sans-serif", fontStyle: "italic" }}>"{drill.close}"</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Next 10 Focus */}
            <div style={{ background: "rgba(22,163,74,.06)", border: "1px solid rgba(22,163,74,.25)", borderLeft: "4px solid #16a34a", padding: "16px 18px", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#16a34a", letterSpacing: ".1em", marginBottom: 6, fontWeight: 600 }}>FOCUS FOR YOUR NEXT 10 CALLS</div>
              <p style={{ fontSize: 16, color: "#334155", lineHeight: 1.7, fontFamily: "'Syne', sans-serif", fontWeight: 600 }}>{milestoneReport.next_10_focus}</p>
            </div>

          </div>
        </div>
      )}

      {/* History View */}
      {showHistory && (
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }} className="fadein">
          <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#94a3b8", marginBottom: 16, fontWeight: 500 }}>CALL HISTORY · {history.length} RECORD{history.length !== 1 ? "S" : ""}</div>
          {history.length === 0 ? (
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "40px 20px", textAlign: "center", borderRadius: 8 }}>
              <div style={{ fontSize: 15, color: "#94a3b8" }}>No calls analyzed yet. Run your first analysis to start building history.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {history.map(entry => {
                const score = entry.result?.scores?.overall;
                const temp = entry.result?.lead_temperature;
                const d = new Date(entry.date);
                const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                return (
                  <div key={entry.id} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16, cursor: "pointer", transition: "border-color .2s" }}
                    onClick={() => loadFromHistory(entry)}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "#b45309"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "#e2e8f0"}>
                    {/* Score */}
                    <div style={{ width: 52, height: 52, borderRadius: "50%", border: `3px solid ${scoreColor(score || 0)}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 700, color: scoreColor(score || 0) }}>{score || "—"}</span>
                    </div>
                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "#1e293b", marginBottom: 4, fontFamily: "'Syne', sans-serif" }}>
                        {entry.contactName || "Unknown Contact"}
                      </div>
                      <div style={{ fontSize: 13, color: "#64748b", display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <span>{dateStr} · {timeStr}</span>
                        <span style={{ textTransform: "capitalize" }}>{entry.callType?.replace("_", " ")}</span>
                        <span style={{ color: "#94a3b8" }}>{entry.fileName}</span>
                      </div>
                    </div>
                    {/* Lead temp badge */}
                    {temp && (
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", color: tempMeta[temp]?.color || "#6b7280", background: `${tempMeta[temp]?.color || "#6b7280"}12`, padding: "4px 10px", borderRadius: 4 }}>
                        {temp.toUpperCase()}
                      </span>
                    )}
                    {/* Delete */}
                    <button onClick={e => { e.stopPropagation(); deleteFromHistory(entry.id); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#cbd5e1", fontSize: 16, padding: "4px 8px", transition: "color .2s" }}
                      onMouseEnter={e => e.target.style.color = "#dc2626"}
                      onMouseLeave={e => e.target.style.color = "#cbd5e1"}
                      title="Delete">
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <button onClick={() => setShowHistory(false)} style={{ marginTop: 20, background: "none", border: "1px solid #e2e8f0", color: "#64748b", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 13, letterSpacing: ".08em", padding: "10px 20px", borderRadius: 6 }}>
            BACK
          </button>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 24px", display: "grid", gridTemplateColumns: step === "done" ? "380px 1fr" : "1fr", gap: 28, ...(showHistory ? { display: "none" } : {}) }}>

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
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
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
                    <div style={{ fontSize: 15, color: "#b45309", marginBottom: 4, fontWeight: 500 }}>{file.name}</div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>{(file.size / 1024 / 1024).toFixed(1)} MB · click to replace</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 14, color: "#64748b", marginBottom: 4 }}>Drop MP3 here or <span style={{ color: "#b45309", fontWeight: 500 }}>browse</span></div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>Works with any Mojo Dialer recording download</div>
                  </div>
                )}
              </div>
            </div>

            {/* Pipeline preview */}
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "16px 18px", marginBottom: 24, borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".12em", marginBottom: 12, fontWeight: 500 }}>PIPELINE</div>
              {["Upload MP3 → AssemblyAI", "Speaker diarization (Agent / Prospect)", "Claude coaching analysis", "Scores + coaching notes + follow-up"].map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: i < 3 ? 10 : 0 }}>
                  <div style={{ width: 5, height: 5, background: "#cbd5e1", borderRadius: "50%", marginTop: 6, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: "#475569", lineHeight: 1.5 }}>{s}</span>
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
                <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "1px solid #e2e8f0" }}>
                  {STEPS.map((s, i) => {
                    const active = s.id === step;
                    const done = currentStepIndex > i;
                    return (
                      <div key={s.id} style={{ flex: 1, padding: "10px 0", textAlign: "center", borderBottom: `2px solid ${active ? "#b45309" : "transparent"}` }}>
                        <div style={{ fontSize: 12, letterSpacing: ".08em", color: active ? "#b45309" : done ? "#64748b" : "#cbd5e1", fontWeight: active ? 500 : 400 }}>
                          {done ? "✓ " : active ? "· " : ""}{s.label.toUpperCase()}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 14, color: "#475569", display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="pulse" style={{ width: 6, height: 6, background: "#b45309", borderRadius: "50%", flexShrink: 0 }} />
                  {progress}
                </div>
              </div>
            )}

            {/* Error */}
            {step === "error" && error && (
              <div style={{ marginTop: 14, padding: "12px 16px", background: "rgba(220,38,38,.06)", border: "1px solid rgba(220,38,38,.2)", fontSize: 14, color: "#dc2626", borderRadius: 6 }}>
                {error}
              </div>
            )}
          </div>
        )}

        {/* LEFT PANEL — Results Sidebar */}
        {step === "done" && result && (
          <div className="fadein">
            {/* Overall score */}
            <div style={{ background: "#fff", border: `1px solid ${scoreColor(result.scores.overall)}40`, padding: "24px 20px", marginBottom: 18, textAlign: "center", borderRadius: 8 }}>
              <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#64748b", marginBottom: 10, fontWeight: 500 }}>OVERALL SCORE</div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 64, fontWeight: 800, color: scoreColor(result.scores.overall), lineHeight: 1 }}>
                {result.scores.overall}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>out of 100</div>
            </div>

            {/* Lead temp */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", background: "#fff", border: "1px solid #e2e8f0", marginBottom: 18, borderRadius: 6 }}>
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".12em", marginBottom: 4, fontWeight: 500 }}>LEAD TEMP</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: tempMeta[result.lead_temperature]?.color || "#6b7280", fontFamily: "'Syne', sans-serif" }}>
                  {result.lead_temperature?.toUpperCase()}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".12em", marginBottom: 4, fontWeight: 500 }}>APPT SET</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: result.appointment_set ? "#16a34a" : "#dc2626", fontFamily: "'Syne', sans-serif" }}>
                  {result.appointment_set ? "YES" : "NO"}
                </div>
              </div>
            </div>

            {/* Talk ratio */}
            {result.talk_ratio_estimate && (
              <div style={{ padding: "12px 18px", background: "#fff", border: "1px solid #e2e8f0", marginBottom: 18, borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: ".12em", marginBottom: 6, fontWeight: 500 }}>TALK RATIO</div>
                <div style={{ fontSize: 15, color: "#475569", fontWeight: 500 }}>{result.talk_ratio_estimate}</div>
              </div>
            )}

            {/* Individual scores */}
            <div style={{ marginBottom: 16 }}>
              {Object.entries(result.scores).filter(([k]) => k !== "overall").map(([key, val]) => {
                const c = scoreColor(val);
                return (
                  <div key={key} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 13, color: "#475569" }}>{SCORE_META[key]?.label}</span>
                      <span style={{ fontSize: 14, color: c, fontWeight: 600 }}>{val}</span>
                    </div>
                    <div style={{ height: 4, background: "#e2e8f0", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${val}%`, background: c, borderRadius: 2, transition: "width 1s ease" }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* File info */}
            <div style={{ padding: "10px 18px", background: "#fff", border: "1px solid #e2e8f0", fontSize: 13, color: "#94a3b8", borderRadius: 6 }}>
              {contactName || "Unknown"} · {callType} · {file?.name}
            </div>

            <button onClick={reset} style={{ marginTop: 14, width: "100%", background: "none", border: "1px solid #e2e8f0", color: "#64748b", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 13, letterSpacing: ".08em", padding: "12px", transition: "all .2s", borderRadius: 6 }}
              onMouseEnter={e => { e.target.style.borderColor = "#94a3b8"; e.target.style.color = "#475569"; }}
              onMouseLeave={e => { e.target.style.borderColor = "#e2e8f0"; e.target.style.color = "#64748b"; }}>
              ANALYZE ANOTHER CALL
            </button>
          </div>
        )}

        {/* RIGHT PANEL — Results Detail */}
        {step === "done" && result && (
          <div className="fadein">
            {/* Summary */}
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "18px 20px", marginBottom: 18, borderRadius: 8 }}>
              <div className="field-label" style={{ marginBottom: 8 }}>Call Summary</div>
              <p style={{ fontSize: 15, color: "#334155", lineHeight: 1.7, fontFamily: "'Syne', sans-serif", fontWeight: 400 }}>
                {result.call_summary}
              </p>
            </div>

            {/* Tabs */}
            <div style={{ borderBottom: "1px solid #e2e8f0", marginBottom: 20, display: "flex" }}>
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
                    <div style={{ fontSize: 14, color: "#b45309", marginBottom: 8, letterSpacing: ".02em", fontWeight: 500 }}>
                      ⚑ {note.issue}
                    </div>
                    <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.7, fontFamily: "'Syne', sans-serif" }}>
                      <span style={{ color: "#94a3b8", fontSize: 11, letterSpacing: ".08em", fontWeight: 500 }}>TRY INSTEAD: </span>
                      {note.fix}
                    </div>
                  </div>
                ))}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
                  {result.best_moment && (
                    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: "3px solid #16a34a", padding: "14px 16px", borderRadius: 6 }}>
                      <div style={{ fontSize: 11, color: "#16a34a", letterSpacing: ".1em", marginBottom: 8, fontWeight: 500 }}>BEST MOMENT</div>
                      <p style={{ fontSize: 14, color: "#475569", lineHeight: 1.6, fontFamily: "'Syne', sans-serif" }}>{result.best_moment}</p>
                    </div>
                  )}
                  {result.missed_opportunity && (
                    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: "3px solid #dc2626", padding: "14px 16px", borderRadius: 6 }}>
                      <div style={{ fontSize: 11, color: "#dc2626", letterSpacing: ".1em", marginBottom: 8, fontWeight: 500 }}>MISSED OPPORTUNITY</div>
                      <p style={{ fontSize: 14, color: "#475569", lineHeight: 1.6, fontFamily: "'Syne', sans-serif" }}>{result.missed_opportunity}</p>
                    </div>
                  )}
                </div>

                {result.objections_detected?.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div className="field-label">Objections Detected</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {result.objections_detected.map((o, i) => (
                        <span key={i} style={{ fontSize: 13, color: "#dc2626", background: "rgba(220,38,38,.06)", border: "1px solid rgba(220,38,38,.2)", padding: "6px 12px", borderRadius: 4 }}>{o}</span>
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
                      <div key={i} style={{ padding: "10px 14px", background: "#fff", border: "1px solid #e2e8f0", marginBottom: 8, fontSize: 14, color: "#475569", fontFamily: "'Syne', sans-serif", borderRadius: 6 }}>
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
                <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: "3px solid #b45309", padding: "18px 20px", marginBottom: 22, borderRadius: 6 }}>
                  <p style={{ fontSize: 16, color: "#334155", lineHeight: 1.7, fontFamily: "'Syne', sans-serif" }}>
                    {result.recommended_followup}
                  </p>
                </div>

                {result.next_step_detail && result.appointment_set && (
                  <div style={{ background: "#fff", border: "1px solid rgba(22,163,74,.2)", padding: "14px 18px", marginBottom: 18, borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: "#16a34a", letterSpacing: ".1em", marginBottom: 6, fontWeight: 500 }}>APPOINTMENT DETAIL</div>
                    <p style={{ fontSize: 14, color: "#475569", fontFamily: "'Syne', sans-serif" }}>{result.next_step_detail}</p>
                  </div>
                )}

                <div style={{ padding: "14px 18px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6 }}>
                  <div className="field-label">GHL Integration</div>
                  <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.7, fontFamily: "'Syne', sans-serif" }}>
                    To auto-push this analysis to GoHighLevel, run the N8N workflow with contact_id and the MP3 URL. The workflow will add the full scorecard as a contact note and tag hot leads automatically.
                  </div>
                </div>
              </div>
            )}

            {/* TRANSCRIPT */}
            {activeTab === "transcript" && (
              <div className="fadein">
                <div className="field-label">Diarized Transcript</div>
                <div style={{ background: "#fff", border: "1px solid #e2e8f0", padding: "18px 20px", maxHeight: 500, overflowY: "auto", borderRadius: 8 }}>
                  {transcript ? transcript.split("\n\n").map((line, i) => {
                    const isAgent = line.startsWith("Agent:");
                    return (
                      <div key={i} style={{ marginBottom: 14 }}>
                        <span style={{ fontSize: 11, letterSpacing: ".1em", color: isAgent ? "#b45309" : "#2563eb", fontWeight: 600 }}>
                          {isAgent ? "AGENT" : "PROSPECT"}
                        </span>
                        <p style={{ fontSize: 14, color: "#475569", lineHeight: 1.6, marginTop: 4, fontFamily: "'Syne', sans-serif" }}>
                          {line.replace(/^(Agent:|Prospect:)\s*/, "")}
                        </p>
                      </div>
                    );
                  }) : <p style={{ fontSize: 14, color: "#94a3b8" }}>Transcript not available</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


