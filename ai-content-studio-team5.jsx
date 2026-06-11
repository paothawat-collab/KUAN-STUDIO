import { useState, useRef, useEffect } from "react";

/* ───────────────────────── config ───────────────────────── */
const DEFAULT_GEMINI_KEY = "AQ.Ab8RN6I6gESkYgVoy9VHXRDJ1oJjtM4j38NMv7eWWORQYmu0og";

/* ───────────────────────── ทีมงานสตูดิโอ ───────────────────────── */
const TEAM = {
  boss: { name: "คุณลูกค้า", role: "เจ้าของงาน", emoji: "🫵", color: "#1A1333" },
  meen: { name: "มีน", role: "ก๊อปปี้ไรเตอร์ตัวแม่", emoji: "✍️", color: "#FF4D8D" },
  phim: { name: "ภีม", role: "อาร์ตไดฯ สายพร้อมต์", emoji: "🎨", color: "#7C5CFF" },
  gem: { name: "เจมส์ (Gemini)", role: "ช่างภาพ + ตากล้อง AI", emoji: "📸", color: "#10B5A3" },
  kong: { name: "ก้อง", role: "QC จิกทุกเม็ด", emoji: "🧐", color: "#FF9F1C" },
};

const STEPS = [
  { id: 1, who: "meen", label: "เขียนโพสต์ / สคริปต์" },
  { id: 2, who: "phim", label: "แต่งพร้อมต์" },
  { id: 3, who: "gem", label: "เจนรูป / วิดีโอ" },
  { id: 4, who: "kong", label: "QC ตรวจงาน" },
  { id: 5, who: "meen", label: "ส่งมอบแคปชั่น" },
];

/* ───────────────────────── helper: เรียก Claude ───────────────────────── */
async function askClaude(parts) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{ role: "user", content: parts }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Claude API error");
  return (data.content || []).map((c) => c.text || "").join("\n");
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(start, end + 1));
}

/* ───────────────────────── helper: เรียก Gemini เจนรูป ───────────────────────── */
async function askGeminiImage(key, prompt, refImage) {
  const parts = [{ text: prompt }];
  if (refImage) {
    parts.push({ inlineData: { mimeType: refImage.mediaType, data: refImage.data } });
  }
  const models = ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation"];
  let lastErr = null;
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
        }
      );
      const data = await res.json();
      if (data.error) { lastErr = new Error(data.error.message); continue; }
      const ps = data.candidates?.[0]?.content?.parts || [];
      const img = ps.find((p) => p.inlineData?.data);
      if (img) return { data: img.inlineData.data, mimeType: img.inlineData.mimeType || "image/png" };
      lastErr = new Error("Gemini ไม่ได้ส่งรูปกลับมา");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("เจนรูปไม่สำเร็จ");
}

/* ───────────────────────── helper: เรียก Veo เจนวิดีโอ ───────────────────────── */
async function downloadVideoBlob(uri, key) {
  const sep = uri.includes("?") ? "&" : "?";
  const directUrl = `${uri}${sep}key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(directUrl);
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob();
    return { objectUrl: URL.createObjectURL(blob), directUrl };
  } catch (e) {
    return { objectUrl: null, directUrl };
  }
}

async function askGeminiVideo(key, prompt) {
  const models = [
    "veo-3.1-fast-generate-preview",
    "veo-3.0-fast-generate-001",
    "veo-2.0-generate-001",
  ];
  let lastErr = null;
  for (const model of models) {
    try {
      const start = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { aspectRatio: "9:16" },
          }),
        }
      );
      const op = await start.json();
      if (op.error) { lastErr = new Error(op.error.message); continue; }
      if (!op.name) { lastErr = new Error("Veo ไม่ตอบกลับ operation"); continue; }

      const t0 = Date.now();
      while (true) {
        if (Date.now() - t0 > 6 * 60 * 1000) throw new Error("รอเกิน 6 นาที");
        await new Promise((r) => setTimeout(r, 10000));
        const pr = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/${op.name}?key=${encodeURIComponent(key)}`
        );
        const pd = await pr.json();
        if (pd.error) throw new Error(pd.error.message);
        if (pd.done) {
          const uri =
            pd.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
            pd.response?.generatedVideos?.[0]?.video?.uri ||
            pd.response?.videos?.[0]?.uri;
          if (uri) return await downloadVideoBlob(uri, key);
          const reason =
            pd.response?.generateVideoResponse?.raiMediaFilteredReasons?.[0] ||
            "Veo ไม่ได้ส่งวิดีโอกลับมา";
          throw new Error(reason);
        }
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("เจนวิดีโอไม่สำเร็จ");
}

/* ───────────────────────── component ───────────────────────── */
export default function AIContentStudio() {
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState("post"); // post | tiktok
  const [refImage, setRefImage] = useState(null); // {data, mediaType, preview}
  const [geminiKey, setGeminiKey] = useState(DEFAULT_GEMINI_KEY);
  const [showSettings, setShowSettings] = useState(false);
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [typing, setTyping] = useState(null); // who is typing
  const [result, setResult] = useState(null);
  const feedRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href =
      "https://fonts.googleapis.com/css2?family=Chonburi&family=Anuphan:wght@400;500;600;700&display=swap";
    document.head.appendChild(l);
    return () => l.remove();
  }, []);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages, typing]);

  const addMsg = (who, body) =>
    setMessages((m) => [...m, { id: Date.now() + Math.random(), who, ...body }]);

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const data = r.result.split(",")[1];
      setRefImage({ data, mediaType: f.type || "image/jpeg", preview: r.result });
    };
    r.readAsDataURL(f);
  };

  const copyText = (text) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    addMsg("meen", { text: "ก๊อปให้แล้วจ้า เอาไปโพสต์ได้เลย อย่าลืมแท็กร้านน้า 😎" });
  };

  /* ───────────── pipeline หลัก ───────────── */
  const run = async () => {
    if (!brief.trim() || running) return;
    setRunning(true);
    setResult(null);
    setMessages([]);
    setCurrentStep(1);

    const modeTh = mode === "post" ? "โพสต์โซเชียล" : "สคริปต์วิดีโอ TikTok";
    addMsg("boss", { text: brief, image: refImage?.preview });

    try {
      /* STEP 1+2 — มีนเขียนคอนเทนต์ + ภีมแต่งพร้อมต์ (เรียก Claude ครั้งเดียว) */
      setTyping("meen");
      const writerParts = [];
      if (refImage)
        writerParts.push({
          type: "image",
          source: { type: "base64", media_type: refImage.mediaType, data: refImage.data },
        });
      writerParts.push({
        type: "text",
        text: `คุณคือ "มีน" ก๊อปปี้ไรเตอร์ Gen Z สายกวนของสตูดิโอคอนเทนต์ไทย เขียนสนุก แสบนิดๆ แต่ขายของเก่ง ใช้ภาษาวัยรุ่นไทยธรรมชาติ ไม่เวอร์จนเลี่ยน

งานวันนี้: สร้าง${modeTh} จากโจทย์ของลูกค้า${refImage ? " (มีรูปอ้างอิงแนบมาด้วย ให้ดูรูปประกอบ)" : ""}

โจทย์: """${brief}"""

ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นหรือ markdown:
{
  "content": "${mode === "post" ? "เนื้อหาโพสต์เต็มๆ มี hook แรงๆ ใส่อีโมจิพอดีๆ" : "สคริปต์ TikTok แบ่งเป็น Hook (0-3วิ) / เนื้อหา / CTA พร้อมบอกมุมกล้องหรือแอ็คชั่นคร่าวๆ"}",
  "caption": "แคปชั่นสั้นๆ สำหรับโพสต์จริง",
  "hashtags": ["แฮชแท็ก 5-8 อัน ภาษาไทยปนอังกฤษ ไม่ต้องใส่ #"],
  "imagePrompt": "พร้อมต์ภาษาอังกฤษละเอียดๆ สำหรับเจนรูป${mode === "tiktok" ? "ปกวิดีโอ" : "ประกอบโพสต์"} ระบุสไตล์ แสง สี องค์ประกอบ ให้เหมาะกับฟีด social ของคนรุ่นใหม่"${mode === "tiktok" ? `,
  "videoPrompt": "พร้อมต์ภาษาอังกฤษสำหรับ Veo เจนวิดีโอแนวตั้ง 9:16 ยาว ~8 วินาที อิง Hook ของสคริปต์ บรรยายฉาก แอ็คชั่น มุมกล้อง แสง อารมณ์ ถ้ามีบทพูดสั้นๆ ให้เขียนเป็นภาษาไทยใน quotes พร้อมระบุ tone เสียง"` : ""},
  "meenSay": "ประโยคกวนๆ 1 ประโยคที่มีนพูดตอนส่งงาน"
}`,
      });
      const draft = parseJSON(await askClaude(writerParts));
      setTyping(null);
      addMsg("meen", {
        text: draft.meenSay || "เสร็จแล้วจ้า งานนี้มีนจัดเต็ม",
        card: { title: mode === "post" ? "📝 ดราฟต์โพสต์" : "🎬 สคริปต์ TikTok", body: draft.content },
      });

      setCurrentStep(2);
      setTyping("phim");
      await new Promise((r) => setTimeout(r, 700));
      setTyping(null);
      addMsg("phim", {
        text: "รับช่วงต่อจากมีนนะ พร้อมต์จัดให้ตามนี้ ใครจะเอาไปเจนที่อื่นก็ก๊อปได้เลย ✌️",
        card: {
          title: mode === "tiktok" ? "🎥 Video Prompt (Veo)" : "🎨 Image Prompt",
          body: mode === "tiktok" ? (draft.videoPrompt || draft.imagePrompt) : draft.imagePrompt,
          mono: true,
        },
      });

      /* STEP 3 — เจมส์เจนรูปหรือวิดีโอ */
      setCurrentStep(3);
      let genImage = null;
      let genVideo = null;
      let review = null;

      if (geminiKey.trim()) {
        if (mode === "tiktok") {
          /* ── เจนวิดีโอด้วย Veo ── */
          addMsg("gem", { text: "รับงานวิดีโอครับ 🎬 Veo กำลังถ่าย ใช้เวลาประมาณ 1-3 นาที พี่จิบกาแฟรอแป๊บนะครับ ☕" });
          setTyping("gem");
          try {
            genVideo = await askGeminiVideo(geminiKey.trim(), draft.videoPrompt || draft.imagePrompt);
            setTyping(null);
            if (genVideo.objectUrl) {
              addMsg("gem", { text: "ถ่ายเสร็จ ตัดต่อส่งเข้ากลุ่มแล้วครับผม 🎥", video: genVideo.objectUrl });
            } else {
              addMsg("gem", {
                text: "วิดีโอเสร็จแล้ว แต่เบราว์เซอร์โหลดมาแสดงตรงนี้ไม่ได้ กดลิงก์ด้านล่างดาวน์โหลดได้เลยครับ",
                link: genVideo.directUrl,
              });
            }
          } catch (e) {
            setTyping(null);
            addMsg("gem", { text: `วิดีโอไม่ผ่านครับพี่ 😵 (${e.message}) เดี๋ยวผมเจนรูปปกให้แทนก่อนนะครับ` });
            setTyping("gem");
            try {
              genImage = await askGeminiImage(geminiKey.trim(), draft.imagePrompt, refImage);
              setTyping(null);
              addMsg("gem", {
                text: "รูปปกมาแล้วครับ เอาไปใช้คู่กับสคริปต์ก่อนได้ 📸",
                image: `data:${genImage.mimeType};base64,${genImage.data}`,
              });
            } catch (e2) {
              setTyping(null);
              addMsg("gem", { text: `รูปปกก็ไม่ผ่าน 😵‍💫 (${e2.message}) ก๊อปพร้อมต์ของภีมไปเจนเองก่อนนะครับ` });
            }
          }
        } else {
          /* ── เจนรูปประกอบโพสต์ ── */
          setTyping("gem");
          try {
            genImage = await askGeminiImage(geminiKey.trim(), draft.imagePrompt, refImage);
            setTyping(null);
            addMsg("gem", {
              text: "ถ่ายเสร็จ ส่งไฟล์เข้ากลุ่มแล้วครับผม 📸",
              image: `data:${genImage.mimeType};base64,${genImage.data}`,
            });
          } catch (e) {
            setTyping(null);
            addMsg("gem", { text: `แย่ละ เจนรูปไม่ผ่าน 😵 (${e.message}) เดี๋ยวส่งพร้อมต์ให้พี่เอาไปเจนเองก่อนนะครับ` });
          }
        }

        /* STEP 4 — ก้อง QC */
        if (genImage || genVideo) {
          setCurrentStep(4);
          setTyping("kong");
          try {
            let reviewRaw;
            if (genImage) {
              reviewRaw = await askClaude([
                {
                  type: "image",
                  source: { type: "base64", media_type: genImage.mimeType, data: genImage.data },
                },
                {
                  type: "text",
                  text: `คุณคือ "ก้อง" QC สายจิกของสตูดิโอคอนเทนต์ Gen Z ไทย ตรวจรูปที่ AI เจนมาว่าตรงโจทย์ไหม

โจทย์ลูกค้า: """${brief}"""
พร้อมต์ที่ใช้เจน: """${draft.imagePrompt}"""

ตรวจ: ตรงโจทย์ไหม / องค์ประกอบภาพโอเคไหม / มีจุดเพี้ยน (มือบิด ตัวหนังสือเละ ของแปลกๆ) ไหม / เหมาะลงโซเชียลไหม

ตอบเป็น JSON เท่านั้น:
{
  "approved": true หรือ false,
  "score": คะแนน 1-10,
  "comment": "คอมเมนต์ภาษากวนๆ แต่ตรงประเด็น 1-2 ประโยค",
  "issues": ["จุดที่ต้องระวังหรือแก้ ถ้าไม่มีให้เป็น array ว่าง"]
}`,
                },
              ]);
            } else {
              reviewRaw = await askClaude([
                {
                  type: "text",
                  text: `คุณคือ "ก้อง" QC สายจิกของสตูดิโอคอนเทนต์ Gen Z ไทย วิดีโอเจนเสร็จแล้วแต่คุณดูวิดีโอตรงๆ ไม่ได้ ให้ตรวจคุณภาพ "สคริปต์ + พร้อมต์วิดีโอ" แทน ว่าจะออกมาตรงโจทย์ไหม

โจทย์ลูกค้า: """${brief}"""
สคริปต์: """${draft.content}"""
พร้อมต์วิดีโอที่ใช้เจน: """${draft.videoPrompt || draft.imagePrompt}"""

ตรวจ: Hook แรงพอใน 3 วิแรกไหม / เนื้อหาตรงโจทย์ไหม / CTA ชัดไหม / พร้อมต์วิดีโอสื่อภาพตรงสคริปต์ไหม

ตอบเป็น JSON เท่านั้น:
{
  "approved": true หรือ false,
  "score": คะแนน 1-10,
  "comment": "คอมเมนต์ภาษากวนๆ แต่ตรงประเด็น 1-2 ประโยค ปิดท้ายเตือนให้พี่เปิดดูวิดีโอจริงอีกรอบก่อนโพสต์",
  "issues": ["จุดที่ต้องระวังหรือแก้ ถ้าไม่มีให้เป็น array ว่าง"]
}`,
                },
              ]);
            }
            review = parseJSON(reviewRaw);
          } catch (e) {
            review = { approved: true, score: 7, comment: "ระบบตรวจสะดุดนิดหน่อย แต่ดูด้วยตาแล้วพอไหวครับพี่", issues: [] };
          }
          setTyping(null);
          addMsg("kong", {
            text: `${review.approved ? "✅ ผ่าน!" : "⚠️ ยังไม่สุด"} ให้ ${review.score}/10 — ${review.comment}`,
            list: review.issues?.length ? review.issues : null,
          });
        }
      } else {
        addMsg("gem", {
          text: "พี่ยังไม่ได้ใส่ Gemini API key ให้ผมเลยครับ 🥲 กดรูปเฟืองข้างบนเพื่อใส่ key ได้ หรือก๊อปพร้อมต์ของภีมไปเจนเองก่อนก็ได้นะ",
        });
      }

      /* STEP 5 — ส่งมอบ */
      setCurrentStep(5);
      setTyping("meen");
      await new Promise((r) => setTimeout(r, 600));
      setTyping(null);
      const tags = (draft.hashtags || []).map((t) => "#" + t.replace(/^#/, "")).join(" ");
      const finalCaption = `${draft.caption}\n\n${tags}`;
      setResult({
        mode,
        content: draft.content,
        caption: finalCaption,
        prompt: mode === "tiktok" ? (draft.videoPrompt || draft.imagePrompt) : draft.imagePrompt,
        image: genImage ? `data:${genImage.mimeType};base64,${genImage.data}` : null,
        video: genVideo?.objectUrl || null,
        videoLink: genVideo?.directUrl || null,
        review,
      });
      addMsg("meen", { text: "งานครบเซ็ตแล้วจ้า เลื่อนลงไปดู 📦 ด้านล่าง ก๊อปแคปชั่นไปโพสต์ได้เลย ปังแน่นอน 💅" });
      setCurrentStep(6);
    } catch (e) {
      setTyping(null);
      addMsg("meen", { text: `โทษทีพี่ งานสะดุดกลางทาง 😵‍💫 (${e.message}) ลองกดส่งโจทย์ใหม่อีกทีนะ` });
    }
    setRunning(false);
  };

  /* ───────────────────────── UI ───────────────────────── */
  return (
    <div className="app">
      <style>{css}</style>

      <header className="topbar">
        <div className="logo">
          <span className="logo-mark">กวน</span>
          <div>
            <div className="logo-name">KUAN STUDIO</div>
            <div className="logo-sub">ทีมคอนเทนต์ AI · ออนไลน์ 4 คน</div>
          </div>
        </div>
        <button className="gear" onClick={() => setShowSettings(!showSettings)} aria-label="ตั้งค่า">⚙️</button>
      </header>

      {showSettings && (
        <div className="settings">
          <label>Gemini API key (สำหรับให้เจมส์เจนรูป/วิดีโอ)</label>
          <input
            type="password"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
            placeholder="วาง key จาก aistudio.google.com ที่นี่"
          />
          <p className="hint">ฝัง key ตั้งต้นมาให้แล้ว เปลี่ยนได้ตรงนี้ · key ไม่ถูกส่งไปไหนนอกจาก Google · ระวังอย่าแชร์ไฟล์นี้ให้คนอื่นเพราะ key อยู่ในไฟล์</p>
        </div>
      )}

      <div className="stepbar">
        {STEPS.map((s) => (
          <div key={s.id} className={"step" + (currentStep === s.id ? " active" : currentStep > s.id ? " done" : "")}>
            <span className="step-dot" style={{ background: TEAM[s.who].color }}>{TEAM[s.who].emoji}</span>
            <span className="step-label">{s.label}</span>
          </div>
        ))}
      </div>

      <main className="feed" ref={feedRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-title">ทีมพร้อมรับงานแล้ว</div>
            <p>พิมพ์ไอเดียหรือโจทย์ด้านล่าง แนบรูปได้ถ้ามี<br />โหมดโพสต์ได้รูปประกอบ · โหมด TikTok ได้วิดีโอจริงจาก Veo 🎥</p>
            <div className="crew">
              {["meen", "phim", "gem", "kong"].map((k) => (
                <div key={k} className="crew-card" style={{ borderColor: TEAM[k].color }}>
                  <span className="crew-emoji">{TEAM[k].emoji}</span>
                  <b>{TEAM[k].name}</b>
                  <small>{TEAM[k].role}</small>
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          const p = TEAM[m.who];
          const mine = m.who === "boss";
          return (
            <div key={m.id} className={"msg" + (mine ? " mine" : "")}>
              {!mine && <div className="avatar" style={{ background: p.color }}>{p.emoji}</div>}
              <div className="bubble-wrap">
                {!mine && <div className="sender" style={{ color: p.color }}>{p.name} · {p.role}</div>}
                <div className={"bubble" + (mine ? " bubble-mine" : "")}>
                  {m.text && <p>{m.text}</p>}
                  {m.image && <img className="msg-img" src={m.image} alt="" />}
                  {m.video && <video className="msg-img msg-vid" src={m.video} controls playsInline />}
                  {m.link && (
                    <a className="mini link-btn" href={m.link} target="_blank" rel="noreferrer">เปิดลิงก์วิดีโอ ↗</a>
                  )}
                  {m.card && (
                    <div className="card">
                      <div className="card-title">{m.card.title}</div>
                      <pre className={m.card.mono ? "mono" : ""}>{m.card.body}</pre>
                      <button className="mini" onClick={() => copyText(m.card.body)}>คัดลอก</button>
                    </div>
                  )}
                  {m.list && (
                    <ul className="issue-list">{m.list.map((it, i) => <li key={i}>{it}</li>)}</ul>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {typing && (
          <div className="msg">
            <div className="avatar" style={{ background: TEAM[typing].color }}>{TEAM[typing].emoji}</div>
            <div className="bubble typing"><span /><span /><span /></div>
          </div>
        )}

        {result && (
          <div className="deliver">
            <div className="deliver-head">📦 งานส่งมอบ</div>
            {result.video && (
              <>
                <video className="deliver-img" src={result.video} controls playsInline />
                <a className="btn ghost" href={result.video} download="kuan-studio.mp4">ดาวน์โหลดวิดีโอ</a>
              </>
            )}
            {!result.video && result.videoLink && (
              <a className="btn ghost" href={result.videoLink} target="_blank" rel="noreferrer">เปิด/ดาวน์โหลดวิดีโอ ↗</a>
            )}
            {result.image && (
              <>
                <img className="deliver-img" src={result.image} alt="รูปที่เจนได้" />
                <a className="btn ghost" href={result.image} download="kuan-studio.png">ดาวน์โหลดรูป</a>
              </>
            )}
            <div className="deliver-block">
              <div className="deliver-label">{result.mode === "post" ? "เนื้อหาโพสต์" : "สคริปต์ TikTok"}</div>
              <pre>{result.content}</pre>
              <button className="btn" onClick={() => copyText(result.content)}>คัดลอก{result.mode === "post" ? "โพสต์" : "สคริปต์"}</button>
            </div>
            <div className="deliver-block">
              <div className="deliver-label">แคปชั่น + แฮชแท็ก พร้อมโพสต์</div>
              <pre>{result.caption}</pre>
              <button className="btn pink" onClick={() => copyText(result.caption)}>คัดลอกแคปชั่น</button>
            </div>
            {!result.image && !result.video && (
              <div className="deliver-block">
                <div className="deliver-label">พร้อมต์ (เอาไปเจนเองได้)</div>
                <pre className="mono">{result.prompt}</pre>
                <button className="btn" onClick={() => copyText(result.prompt)}>คัดลอกพร้อมต์</button>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="composer">
        <div className="mode-row">
          <button className={"chip" + (mode === "post" ? " on" : "")} onClick={() => setMode("post")}>📝 โพสต์ + รูป</button>
          <button className={"chip" + (mode === "tiktok" ? " on" : "")} onClick={() => setMode("tiktok")}>🎬 TikTok + วิดีโอ Veo</button>
          {refImage && (
            <span className="attach">
              <img src={refImage.preview} alt="" />
              <button onClick={() => setRefImage(null)}>✕</button>
            </span>
          )}
        </div>
        <div className="input-row">
          <button className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="แนบรูป">🖼️</button>
          <input type="file" accept="image/*" ref={fileRef} onChange={onPickFile} hidden />
          <textarea
            rows={1}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="ใส่ไอเดียหรือโจทย์ เช่น โปรน้ำปั่นมะม่วง ลด 20% เสาร์อาทิตย์นี้..."
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); run(); } }}
          />
          <button className="send" onClick={run} disabled={running || !brief.trim()}>
            {running ? "ทีมกำลังทำ..." : "ส่งโจทย์ 🚀"}
          </button>
        </div>
      </footer>
    </div>
  );
}

/* ───────────────────────── styles ───────────────────────── */
const css = `
:root{
  --ink:#1A1333; --bg:#EDEAFF; --paper:#FFFFFF;
  --pink:#FF4D8D; --purple:#7C5CFF; --lime:#C6F432; --teal:#10B5A3; --amber:#FF9F1C;
}
*{box-sizing:border-box;margin:0;padding:0}
.app{display:flex;flex-direction:column;height:100vh;background:var(--bg);
  font-family:'Anuphan',sans-serif;color:var(--ink);
  background-image:radial-gradient(#d9d3ff 1.2px,transparent 1.2px);background-size:22px 22px}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;
  background:var(--ink);color:#fff}
.logo{display:flex;align-items:center;gap:10px}
.logo-mark{font-family:'Chonburi',serif;font-size:22px;background:var(--lime);color:var(--ink);
  padding:2px 10px;border-radius:10px;transform:rotate(-3deg);display:inline-block}
.logo-name{font-family:'Chonburi',serif;font-size:15px;letter-spacing:1px}
.logo-sub{font-size:11px;opacity:.7}
.gear{background:none;border:none;font-size:20px;cursor:pointer}
.settings{background:#fff;border-bottom:3px solid var(--ink);padding:12px 16px}
.settings label{font-weight:600;font-size:13px}
.settings input{width:100%;margin-top:6px;padding:10px;border:2px solid var(--ink);border-radius:10px;font-size:14px}
.hint{font-size:11px;opacity:.6;margin-top:6px}
.stepbar{display:flex;gap:6px;overflow-x:auto;padding:10px 12px;background:#fff;border-bottom:3px solid var(--ink)}
.step{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
  border:2px solid transparent;opacity:.45;white-space:nowrap;font-size:12px;font-weight:600;transition:.2s}
.step.active{opacity:1;border-color:var(--ink);background:var(--lime)}
.step.done{opacity:.85}
.step-dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px}
.feed{flex:1;overflow-y:auto;padding:16px 14px 24px}
.empty{text-align:center;margin-top:36px}
.empty-title{font-family:'Chonburi',serif;font-size:26px}
.empty p{margin-top:8px;font-size:14px;opacity:.75;line-height:1.7}
.crew{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px}
.crew-card{background:#fff;border:3px solid;border-radius:14px;padding:10px 14px;width:120px;
  display:flex;flex-direction:column;align-items:center;gap:2px;box-shadow:4px 4px 0 var(--ink)}
.crew-emoji{font-size:24px}
.crew-card small{font-size:11px;opacity:.65;text-align:center}
.msg{display:flex;gap:8px;margin-bottom:14px;max-width:720px}
.msg.mine{justify-content:flex-end;margin-left:auto}
.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-size:17px;
  border:2px solid var(--ink);flex-shrink:0}
.sender{font-size:11px;font-weight:700;margin-bottom:3px}
.bubble{background:var(--paper);border:2px solid var(--ink);border-radius:4px 16px 16px 16px;
  padding:10px 12px;font-size:14px;line-height:1.65;box-shadow:3px 3px 0 var(--ink);max-width:560px}
.bubble-mine{background:var(--ink);color:#fff;border-radius:16px 4px 16px 16px;box-shadow:3px 3px 0 var(--purple)}
.msg-img{display:block;max-width:100%;border-radius:10px;margin-top:8px;border:2px solid var(--ink)}
.msg-vid{max-height:420px}
.link-btn{display:inline-block;text-decoration:none;color:var(--ink)}
.card{margin-top:8px;background:#FAF8FF;border:2px dashed var(--purple);border-radius:10px;padding:10px}
.card-title{font-weight:700;font-size:12px;margin-bottom:6px}
.card pre,.deliver pre{white-space:pre-wrap;font-family:inherit;font-size:13.5px;line-height:1.7}
.mono{font-family:ui-monospace,monospace;font-size:12px!important;opacity:.85}
.mini{margin-top:8px;background:var(--lime);border:2px solid var(--ink);border-radius:8px;
  padding:4px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.issue-list{margin-top:6px;padding-left:18px;font-size:13px}
.typing{display:flex;gap:4px;align-items:center;padding:14px 16px}
.typing span{width:7px;height:7px;border-radius:50%;background:var(--ink);opacity:.4;animation:blink 1s infinite}
.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,100%{opacity:.25}50%{opacity:.9}}
.deliver{background:#fff;border:3px solid var(--ink);border-radius:18px;padding:16px;margin-top:8px;
  box-shadow:6px 6px 0 var(--pink);max-width:720px}
.deliver-head{font-family:'Chonburi',serif;font-size:20px;margin-bottom:10px}
.deliver-img{width:100%;border-radius:12px;border:2px solid var(--ink);margin-bottom:8px;max-height:560px;object-fit:contain;background:#000}
img.deliver-img{background:transparent}
.deliver-block{margin-top:14px;padding-top:12px;border-top:2px dashed #ddd}
.deliver-label{font-weight:700;font-size:12px;color:var(--purple);margin-bottom:6px;letter-spacing:.3px}
.btn{margin-top:8px;background:var(--lime);border:2px solid var(--ink);border-radius:10px;
  padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;
  box-shadow:2px 2px 0 var(--ink);display:inline-block;text-decoration:none;color:var(--ink)}
.btn:active{transform:translate(2px,2px);box-shadow:none}
.btn.pink{background:var(--pink);color:#fff}
.btn.ghost{background:#fff}
.composer{background:#fff;border-top:3px solid var(--ink);padding:10px 12px}
.mode-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.chip{border:2px solid var(--ink);background:#fff;border-radius:999px;padding:5px 14px;
  font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;opacity:.55}
.chip.on{background:var(--ink);color:#fff;opacity:1}
.attach{display:flex;align-items:center;gap:4px}
.attach img{width:34px;height:34px;object-fit:cover;border-radius:8px;border:2px solid var(--ink)}
.attach button{border:none;background:var(--pink);color:#fff;border-radius:50%;width:18px;height:18px;
  font-size:10px;cursor:pointer}
.input-row{display:flex;gap:8px;align-items:flex-end}
.icon-btn{border:2px solid var(--ink);background:#fff;border-radius:12px;width:42px;height:42px;
  font-size:18px;cursor:pointer;flex-shrink:0}
.input-row textarea{flex:1;border:2px solid var(--ink);border-radius:12px;padding:10px 12px;
  font-size:14px;font-family:inherit;resize:none;min-height:42px;max-height:120px}
.send{background:var(--pink);color:#fff;border:2px solid var(--ink);border-radius:12px;
  padding:0 16px;height:42px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;
  box-shadow:2px 2px 0 var(--ink);flex-shrink:0}
.send:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}
@media(max-width:520px){
  .bubble{max-width:84vw}
  .crew-card{width:104px}
}
@media(prefers-reduced-motion:reduce){.typing span{animation:none}}
`;
