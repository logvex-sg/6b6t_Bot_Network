import assert from "node:assert/strict";
import test from "node:test";
import { normaliseName, parseChatLine, parseKitRequest } from "./chatParse.ts";

test("parses vanilla chat", () => {
  assert.deepEqual(parseChatLine("<Steve> !kit"), { username: "Steve", message: "!kit" });
});

test("parses plugin-style chat with a rank prefix", () => {
  assert.deepEqual(parseChatLine("[VIP] Steve: !kit"), { username: "Steve", message: "!kit" });
  assert.deepEqual(parseChatLine("Steve: !kit"), { username: "Steve", message: "!kit" });
  assert.deepEqual(parseChatLine("Steve » !kit"), { username: "Steve", message: "!kit" });
});

test("parses whispers", () => {
  assert.deepEqual(parseChatLine("[Steve -> me] !kit"), { username: "Steve", message: "!kit" });
  assert.deepEqual(parseChatLine("[Steve → me] !kit"), { username: "Steve", message: "!kit" });
  assert.deepEqual(parseChatLine("Steve whispers to you: !kit"), { username: "Steve", message: "!kit" });
});

test("ignores lines that are not chat at all", () => {
  assert.equal(parseChatLine("Steve joined the game"), null);
  assert.equal(parseChatLine("Steve left the game"), null);
  assert.equal(parseChatLine(""), null);
  assert.equal(parseChatLine("   "), null);
});

test("system text that mimics `Name: text` is not treated as a kit request", () => {
  // `Server: restarting in 5 minutes` is ambiguous — it fits the `Name: message` shape. The kit bot's real
  // gate is the prefix, so the guarantee that matters is that such a line never becomes a kit request.
  assert.equal(parseKitRequest("Server: restarting in 5 minutes", "!"), null);
  assert.equal(parseKitRequest("Steve joined the game", "!"), null);
});

test("collapses whitespace", () => {
  assert.deepEqual(parseChatLine("<Steve>   !kit   now "), { username: "Steve", message: "!kit now" });
});

test("recognises a prefixed request", () => {
  const req = parseKitRequest("<Steve> !kit", "!");
  assert.ok(req);
  assert.equal(req.username, "Steve");
  assert.equal(req.command, "kit");
  assert.deepEqual(req.args, []);
});

test("prefix matching is case-insensitive", () => {
  assert.equal(parseKitRequest("<Steve> !KIT", "!")?.command, "kit");
  assert.equal(parseKitRequest("<Steve> !Kit pvp", "!")?.command, "kit");
});

test("accepts a custom prefix", () => {
  const req = parseKitRequest("<Steve> .kit", ".");
  assert.ok(req);
  assert.equal(req.command, "kit");
});

test("rejects chat that does not start with the prefix", () => {
  assert.equal(parseKitRequest("<Steve> kit", "!"), null);
  assert.equal(parseKitRequest("<Steve> hello !kit", "!"), null);
});

test("bare prefix yields an empty command", () => {
  const req = parseKitRequest("<Steve> !", "!");
  assert.ok(req);
  assert.equal(req.command, "");
});

test("captures args", () => {
  const req = parseKitRequest("<Steve> !kit pvp extra", "!");
  assert.ok(req);
  assert.deepEqual(req.args, ["pvp", "extra"]);
});

test("rejects malformed names", () => {
  // Too short to be a real username, and no <...> wrapper — not a chat line we trust.
  assert.equal(parseChatLine("ab: !kit"), null);
});

test("normaliseName lower-cases and trims", () => {
  assert.equal(normaliseName("  Steve "), "steve");
});
