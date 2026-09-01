import { randomBytes } from "node:crypto";

const agentName = process.argv[2]?.trim() || "agent-1";
const stateKey = randomBytes(32).toString("base64url");
const humanAccessKey = randomBytes(32).toString("base64url");
const agentToken = randomBytes(32).toString("base64url");

console.log(`CARTES_STATE_KEY=${stateKey}`);
console.log(`CARTES_HUMAN_ACCESS_KEY=${humanAccessKey}`);
console.log("remote-keys.json:");
console.log(JSON.stringify({ [agentName]: agentToken }, null, 2));
