/* global BigInt, globalThis */
// Independent browser implementation of chicken-road-hmac-v1. These immutable
// archives verify evidence only; they never select an outcome or place a bet.
const TABLES = Object.freeze({
  easy: Object.freeze([106, 113, 120, 127, 134, 142, 151, 160, 169, 180, 190, 202, 214]),
  medium: Object.freeze([112, 128, 147, 170, 198, 233, 276, 332, 403, 496, 620, 691, 890]),
  hard: Object.freeze([135, 183, 247, 333, 449, 606, 818, 1104, 1490, 2011, 2715, 3665, 4947]),
  hardcore: Object.freeze([150, 225, 338, 507, 760, 1140, 1709, 2563, 3845, 5767, 8650, 12975, 19462]),
});
const TARGETS = Object.freeze({ "chicken-road-proposal-v1": 97, "chicken-road-proposal-v2": 90 });
const FAIRNESS_VERSION = "chicken-road-hmac-v1";
const fail = (message) => { throw new Error(message); };
const identifier = (value) => typeof value === "string" && value.length > 0 && Array.from(value).length <= 128;
const hexSeed = (value) => typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function archive(rulesVersion, difficulty, multipliers) {
  if (typeof rulesVersion !== "string" || typeof difficulty !== "string"
    || !Object.prototype.hasOwnProperty.call(TARGETS, rulesVersion) || !Object.prototype.hasOwnProperty.call(TABLES, difficulty)) fail("This rules version or difficulty is not supported by this verifier.");
  const table = TABLES[difficulty];
  if (!same(multipliers, table)) fail("The payout table does not match the locked rules version.");
  return { table, target: TARGETS[rulesVersion] };
}

export function chickenRoadCollisionChances(rulesVersion, difficulty, multipliers) {
  const { table, target } = archive(rulesVersion, difficulty, multipliers);
  return table.map((denominator, index) => ({ numerator: denominator - (index ? table[index - 1] : target), denominator }));
}

// Python json.dumps(..., ensure_ascii=True, separators=(",", ":")) escapes
// individual UTF-16 units (including surrogate pairs); JSON.stringify does not.
function canonical(parts) {
  const ascii = JSON.stringify(parts).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Uint8Array.from(ascii, (char) => char.charCodeAt(0));
}
const hex = (buffer) => Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, "0")).join("");
const seedBytes = (seed) => Uint8Array.from(seed.match(/../g), (value) => parseInt(value, 16));

/** Reproduce evidence against a separately received terminal round, not against
 * fields supplied by the proof itself. Success is mathematical consistency,
 * not certification of the operator, seed freshness, timing, or wallet funding.
 */
export async function verifyChickenRoadFairness(proof, round, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle || typeof BigInt !== "function") fail("This browser cannot verify the proof. Use a browser with Web Crypto support.");
  if (!round || !proof || !identifier(round.id) || proof.round_id !== round.id
    || !["CRASHED", "CASHED"].includes(round.status)) fail("A matching settled round is required before verification.");
  const { table } = archive(round.rules_version, round.difficulty, round.multipliers_hundredths);
  if (round.fairness_version !== FAIRNESS_VERSION || !hexSeed(proof.server_seed)
    || !hexSeed(round.server_seed_hash) || !hexSeed(round.client_seed) || !identifier(round.nonce)) fail("The round contains incomplete or invalid fairness evidence.");
  for (const field of ["rules_version", "fairness_version", "difficulty", "multipliers_hundredths", "server_seed_hash", "client_seed", "nonce"]) {
    if (!same(proof[field], round[field])) fail(`The proof does not match the round's ${field}.`);
  }
  const { lane, amount, reason, status } = round;
  if (!Number.isSafeInteger(lane) || lane < 1 || lane > table.length
    || !Number.isSafeInteger(amount) || amount < 100 || amount > 1000 || amount % 100 !== 0
    || !Number.isSafeInteger(round.version) || round.cashout_amount !== 0
    || typeof round.settled_at !== "string" || !Number.isFinite(Date.parse(round.settled_at))) fail("The terminal round is incomplete or invalid.");
  const crashed = status === "CRASHED";
  const finalLane = reason === "FINAL_LANE";
  if ((crashed && reason !== "COLLISION") || (!crashed && !["PLAYER_CASHOUT", "INACTIVITY", "FINAL_LANE"].includes(reason))
    || (!crashed && finalLane !== (lane === table.length))
    || round.version !== lane + (!crashed && !finalLane ? 1 : 0)
    || round.multiplier_hundredths !== (crashed ? 0 : table[lane - 1])
    || round.payout !== (crashed ? 0 : amount * table[lane - 1] / 100)) fail("The terminal result or payout does not match the locked rules.");

  const subtle = cryptoProvider.subtle;
  // The service uses its commitment ID as the round nonce.
  const commitment = hex(await subtle.digest("SHA-256", canonical([
    "chicken-road:seed-commitment", round.rules_version, FAIRNESS_VERSION, round.nonce, proof.server_seed,
  ])));
  if (commitment !== round.server_seed_hash) fail("The revealed server seed does not match the round's commitment.");
  const key = await subtle.importKey("raw", seedBytes(proof.server_seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const range = BigInt(1) << BigInt(256);
  const chances = chickenRoadCollisionChances(round.rules_version, round.difficulty, table);
  const lanes = [];
  for (let index = 0; index < lane; index += 1) {
    const denominator = BigInt(table[index]);
    const limit = range - range % denominator;
    let draw = null;
    for (let counter = 0; counter < 1000; counter += 1) {
      const digest = await subtle.sign("HMAC", key, canonical([
        "chicken-road:lane", round.rules_version, FAIRNESS_VERSION, round.difficulty,
        index + 1, round.nonce, counter, round.client_seed,
      ]));
      if (digest.byteLength !== 32) fail("The browser returned an invalid verification digest.");
      const sample = BigInt(`0x${hex(digest)}`);
      if (sample < limit) { draw = Number(sample % denominator); break; }
    }
    if (draw === null) fail("The rejection-sampling limit was reached; this proof was not verified.");
    const survived = draw < table[index] - chances[index].numerator;
    if (survived !== !(crashed && index === lane - 1)) fail(`The recorded outcome does not match the proof at lane ${index + 1}.`);
    lanes.push({ lane: index + 1, survived, draw });
  }
  return { roundId: round.id, rulesVersion: round.rules_version, checkedLanes: lane, status, payout: round.payout, commitment, lanes };
}
