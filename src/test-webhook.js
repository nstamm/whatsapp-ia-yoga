/**
 * Simulate an incoming WhatsApp message (for local demo/testing)
 * Usage:
 *   node src/test-webhook.js "Your message here"
 *   node src/test-webhook.js --audio
 */

const isAudioTest = process.argv[2] === "--audio";
const message = isAudioTest ? "" : process.argv[2] ?? "Hello! Who are you?";
const conversationId = `local_test_conversation_${Date.now()}`;

const payload = {
  event: "message.received",
  conversation: {
    id: conversationId,
  },
  message: {
    conversationId,
    direction: "incoming",
    ...(message ? { text: message } : {}),
    ...(isAudioTest ? { audio: { mimeType: "audio/ogg" } } : {}),
    sender: {
      phoneNumber: "+1234567890",
    },
  },
};

const res = await fetch("http://localhost:3000/webhook", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Local-Test": "true" },
  body: JSON.stringify(payload),
});

console.log(`Sent: "${isAudioTest ? "[audio]" : message}"`);
console.log(`Status: ${res.status}`);
