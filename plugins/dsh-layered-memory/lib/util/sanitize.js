function sanitizeText(text) {
  let cleaned = text;
  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, "");
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, "");
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, "");
  cleaned = cleaned.replace(/<memory-tools-guide>[\s\S]*?<\/memory-tools-guide>/g, "");
  cleaned = cleaned.replace(/<current_task_context>[\s\S]*?<\/current_task_context>/g, "");
  cleaned = cleaned.replace(/<history_task_context[\s\S]*?<\/history_task_context>/g, "");
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[\s\S]*?\):\s*```json\s*[\s\S]*?```/g,
    ""
  );
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"session[\s\S]*?\}\s*```/g, "");
  cleaned = cleaned.replace(/\[\[reply_to[^\]]*\]\]\s*/g, "");
  cleaned = cleaned.replace(/¥¥\[[\s\S]*?\]¥¥/g, "");
  cleaned = cleaned.replace(/^\[[\w\d\-:+ ]+\]\s*/gm, "");
  cleaned = cleaned.replace(/\[media attached:[^\]]*\]\s*/g, "");
  cleaned = cleaned.replace(/To send an image back,[\s\S]*?(?:Keep caption in the text body\.)\s*/g, "");
  cleaned = cleaned.replace(/^System:\s*\[[\s\S]*?$/gm, "");
  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "");
  cleaned = cleaned.replace(/\0/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}
function stripCodeBlocks(text) {
  return text.replace(/```[^\n]*\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function shouldCaptureL0(text) {
  if (!text || !text.trim()) return false;
  if (isFrameworkNoise(text)) return false;
  if (text.startsWith("/")) return false;
  return true;
}
function isFrameworkNoise(text) {
  const t = text.trim();
  if (t === "(session bootstrap)") return true;
  if (t.startsWith("A new session was started via")) return true;
  if (/^✅\s*New session started/.test(t)) return true;
  if (t.startsWith("Pre-compaction memory flush")) return true;
  if (/^NO_REPLY\s*$/.test(t)) return true;
  return false;
}
export {
  sanitizeText,
  shouldCaptureL0,
  stripCodeBlocks
};
