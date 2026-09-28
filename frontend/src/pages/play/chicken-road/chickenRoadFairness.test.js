/* global BigInt */
import { webcrypto } from "crypto";
import { chickenRoadCollisionChances, verifyChickenRoadFairness } from "./chickenRoadFairness";

// Generated offline by backend/chicken_road_engine.py (v1/v2): seed_commitment
// and lane_survives, searching deterministic Unicode nonces for each terminal
// reason. Frozen cross-language vectors do not call the Python implementation.
const TABLES = {"easy":[106,113,120,127,134,142,151,160,169,180,190,202,214],"medium":[112,128,147,170,198,233,276,332,403,496,620,691,890],"hard":[135,183,247,333,449,606,818,1104,1490,2011,2715,3665,4947],"hardcore":[150,225,338,507,760,1140,1709,2563,3845,5767,8650,12975,19462]};
const VECTORS = [
  {"version":"chicken-road-proposal-v1","difficulty":"easy","reason":"COLLISION","lane":6,"nonce":"fixture-☃-🪶-easy-COLLISION-4","commitment":"34b665bd8f3111a649db028503e2bac4a92afb823a94b755135ecca86eaad668","survived":[true,true,true,true,true,false,true,true,true,true,true,true,true],"draws":[85,37,112,92,62,138,122,51,42,131,55,180,109]},
  {"version":"chicken-road-proposal-v1","difficulty":"easy","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-easy-PLAYER_CASHOUT-1","commitment":"c3bdf207c4ca4b95cfeff056264e297c409888ad03d1d2ab9d0329da75432bbe","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[58,4,70,28,12,95,132,53,110,163,34,134,126]},
  {"version":"chicken-road-proposal-v1","difficulty":"easy","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-easy-INACTIVITY-0","commitment":"66b9ab4c2f24e4a7d1805c6eac69750013ca54779f3f3a3a0dfc3cde017cb9fb","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[55,71,51,104,34,106,97,114,22,0,5,151,35]},
  {"version":"chicken-road-proposal-v1","difficulty":"easy","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-easy-FINAL_LANE-0","commitment":"9a9e7a1aeb49c40d508bdbaa8d26365c8afa0dadee7ff4bebda7b9684973c598","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[6,56,85,78,12,54,38,134,64,23,12,84,175]},
  {"version":"chicken-road-proposal-v1","difficulty":"medium","reason":"COLLISION","lane":4,"nonce":"fixture-☃-🪶-medium-COLLISION-0","commitment":"6028e42b9a76d5080338c841db7f833d5d9ff0a04045c088362f6b57e38d66b8","survived":[true,true,true,false,true,false,true,false,true,true,true,true,true],"draws":[24,50,12,166,155,205,36,280,208,121,113,28,220]},
  {"version":"chicken-road-proposal-v1","difficulty":"medium","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-medium-PLAYER_CASHOUT-0","commitment":"c11e186f1af6be0242abb279b6ae9845f0257812d4033ce87c7822694de67615","survived":[true,true,true,true,true,true,true,true,true,true,true,false,true],"draws":[29,33,107,3,79,117,53,247,265,169,438,629,502]},
  {"version":"chicken-road-proposal-v1","difficulty":"medium","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-medium-INACTIVITY-0","commitment":"f8c17167e43e60ffe3feccb80000d33b20772e9267bcc595a4d0c2dae738d100","survived":[true,true,true,true,false,true,false,false,true,true,true,true,true],"draws":[6,53,77,59,179,39,254,298,20,27,261,440,100]},
  {"version":"chicken-road-proposal-v1","difficulty":"medium","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-medium-FINAL_LANE-12","commitment":"2f7859012cd93d019294f0dc0360412e519ee03767de1a054e7eda239612832e","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[80,0,0,134,89,16,219,263,126,246,3,486,324]},
  {"version":"chicken-road-proposal-v1","difficulty":"hard","reason":"COLLISION","lane":1,"nonce":"fixture-☃-🪶-hard-COLLISION-0","commitment":"c00ab245bfd22ddd63c834fe5a83f26ad8a5bade7f9ca651558aec29539b713e","survived":[false,true,false,true,true,false,true,true,false,true,true,true,true],"draws":[120,64,238,207,16,509,569,585,1193,470,1037,5,3465]},
  {"version":"chicken-road-proposal-v1","difficulty":"hard","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-hard-PLAYER_CASHOUT-5","commitment":"1457d01ef13562147c3c93a7c80113c95139a84c9543fd09764492120d74dd17","survived":[true,true,true,true,false,true,false,true,true,false,false,true,false],"draws":[23,13,86,166,404,394,802,768,828,1647,2428,898,4800]},
  {"version":"chicken-road-proposal-v1","difficulty":"hard","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-hard-INACTIVITY-5","commitment":"1f36b7d34dc46dd9790deeafa5182531680dff4f4dcf9312945eba1ea5c79425","survived":[true,true,true,true,true,true,true,true,false,true,true,false,true],"draws":[49,8,85,203,141,96,133,266,1213,546,791,3172,2498]},
  {"version":"chicken-road-proposal-v1","difficulty":"hard","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-hard-FINAL_LANE-2","commitment":"7138973906b30b4e515f670fe6a8e44261af66dfc9f7a68a72fd784a310736d4","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[88,103,26,87,95,16,560,792,180,20,896,1375,267]},
  {"version":"chicken-road-proposal-v1","difficulty":"hardcore","reason":"COLLISION","lane":3,"nonce":"fixture-☃-🪶-hardcore-COLLISION-0","commitment":"98a0a93e313c89ab6e56341c51845d13c7e2b566c342481faaa5bab9e94225be","survived":[true,true,false,false,true,false,true,true,true,true,true,true,true],"draws":[8,36,336,430,129,849,1130,659,493,643,5144,8480,12437]},
  {"version":"chicken-road-proposal-v1","difficulty":"hardcore","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-hardcore-PLAYER_CASHOUT-0","commitment":"900770f3de61b52483128634531b4bc36d7d10e06c9e2f5b7f0e8e8681775db3","survived":[true,true,true,true,false,false,false,false,false,true,false,true,true],"draws":[86,58,49,235,694,798,1637,2060,3609,1130,7250,974,7251]},
  {"version":"chicken-road-proposal-v1","difficulty":"hardcore","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-hardcore-INACTIVITY-0","commitment":"75c892373b72d4eda9b216d8811fc65604eab72e8524dc8345b0c937e9bec9eb","survived":[true,true,true,true,false,true,true,true,false,true,true,true,true],"draws":[39,28,122,96,522,132,602,1101,2858,2961,381,3116,9009]},
  {"version":"chicken-road-proposal-v1","difficulty":"hardcore","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-hardcore-FINAL_LANE-56","commitment":"5b083ef5b0cc09c0e1d3ee80c015b4957e57365472309a19f4a2ab5ca91891b8","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[22,10,16,197,246,693,972,1546,115,2649,2221,4147,10352]},
  {"version":"chicken-road-proposal-v2","difficulty":"easy","reason":"COLLISION","lane":5,"nonce":"fixture-☃-🪶-easy-COLLISION-1","commitment":"8c6ce52b1245767104d3101335f619456f4cd43286027060334223feb548366c","survived":[true,true,true,true,false,true,true,false,true,true,true,false,true],"draws":[10,64,68,119,130,40,44,158,53,89,21,198,24]},
  {"version":"chicken-road-proposal-v2","difficulty":"easy","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-easy-PLAYER_CASHOUT-0","commitment":"666d9939ab1384172ceb8993cdf6fcf4f608698b0e05186db0e79aefa8e13878","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[76,35,14,59,99,119,16,29,112,10,147,152,193]},
  {"version":"chicken-road-proposal-v2","difficulty":"easy","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-easy-INACTIVITY-1","commitment":"f9eb416f7ae59885b6f2bd3bb8b9359689fed34964225ac983555fbe1e804e01","survived":[true,true,true,true,true,true,true,true,true,false,true,false,true],"draws":[51,37,65,40,119,103,132,31,153,173,177,196,132]},
  {"version":"chicken-road-proposal-v2","difficulty":"easy","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-easy-FINAL_LANE-2","commitment":"9251d3a8fc2308aa3f121b8c3079b0cb91b13e453128e00142a7d2c13b21f980","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[35,46,81,29,70,94,53,30,60,160,162,47,30]},
  {"version":"chicken-road-proposal-v2","difficulty":"medium","reason":"COLLISION","lane":1,"nonce":"fixture-☃-🪶-medium-COLLISION-0","commitment":"98ca47898e433b282a8cde3c813fe091637901b3dd5b45cb3fdec14e6da9ad06","survived":[false,true,false,false,true,true,true,false,false,false,true,true,true],"draws":[91,51,131,153,63,105,116,287,378,425,13,73,437]},
  {"version":"chicken-road-proposal-v2","difficulty":"medium","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-medium-PLAYER_CASHOUT-0","commitment":"495d0ebffe5cce53d0d9c09a389ee075d32ef604c7bc1d4df3929de524f567cf","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[3,32,39,58,169,187,25,249,196,55,47,400,581]},
  {"version":"chicken-road-proposal-v2","difficulty":"medium","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-medium-INACTIVITY-1","commitment":"a73b3380ae8f9968981e4865b6d534c89c565e7b80264523fe84b081821d9e84","survived":[true,true,true,true,false,true,false,true,false,false,true,true,true],"draws":[12,93,39,92,181,120,258,138,388,406,87,24,47]},
  {"version":"chicken-road-proposal-v2","difficulty":"medium","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-medium-FINAL_LANE-6","commitment":"8ed6e1b367d349d2b70f35b5d5218e44d8363bf8cf11bd22b252a67207a2b1fc","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[83,89,91,2,66,1,194,157,180,195,214,480,200]},
  {"version":"chicken-road-proposal-v2","difficulty":"hard","reason":"COLLISION","lane":1,"nonce":"fixture-☃-🪶-hard-COLLISION-0","commitment":"39ca25259e63d204c06f21a4737beedaf0d27c358c321a19eb61e4624139c16d","survived":[false,false,false,true,true,true,true,true,true,true,true,true,true],"draws":[128,173,192,10,236,245,525,334,59,652,2007,1161,3456]},
  {"version":"chicken-road-proposal-v2","difficulty":"hard","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-hard-PLAYER_CASHOUT-0","commitment":"e9fbcdceffb4d3e8e86ee7655e63c941b94c3103dd91783b48fb388c10da4bf1","survived":[true,true,false,true,true,true,true,true,true,true,false,false,true],"draws":[31,98,210,158,156,119,548,309,1083,1295,2687,3621,1423]},
  {"version":"chicken-road-proposal-v2","difficulty":"hard","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-hard-INACTIVITY-2","commitment":"cb81e21fe7472278837645164710746ed737bcca1ca443834d153f70400678ec","survived":[true,true,true,true,true,true,true,true,false,true,true,true,true],"draws":[29,21,24,166,8,346,80,576,1407,916,1327,830,3553]},
  {"version":"chicken-road-proposal-v2","difficulty":"hard","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-hard-FINAL_LANE-28","commitment":"122b0526b4782f3795bab241a7d5a85c873e35f035b9395817839e85f5bf5aa3","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[42,29,92,29,296,298,244,86,1096,823,60,1016,1707]},
  {"version":"chicken-road-proposal-v2","difficulty":"hardcore","reason":"COLLISION","lane":1,"nonce":"fixture-☃-🪶-hardcore-COLLISION-0","commitment":"a0144e98f1421194b4a67d945a199b5d2cac728a5be792a10092b5b91d815598","survived":[false,true,false,true,false,false,true,false,true,true,true,false,false],"draws":[97,12,295,291,599,1071,1121,2469,571,1613,1196,11214,13686]},
  {"version":"chicken-road-proposal-v2","difficulty":"hardcore","reason":"PLAYER_CASHOUT","lane":2,"nonce":"fixture-☃-🪶-hardcore-PLAYER_CASHOUT-2","commitment":"9d4d475e1873a1bdaa6a47d81a64816c1a6b2077bb4e8c75002d250c61d207c0","survived":[true,true,false,false,true,false,false,true,true,false,true,false,false],"draws":[52,86,263,484,414,1037,1434,936,730,4253,1553,10834,15363]},
  {"version":"chicken-road-proposal-v2","difficulty":"hardcore","reason":"INACTIVITY","lane":3,"nonce":"fixture-☃-🪶-hardcore-INACTIVITY-0","commitment":"ac5ee9a38b734fc4e61802d3957e2b7fa6d770601cbb4afdfec64abf108ed41f","survived":[true,true,true,true,false,false,true,false,true,false,false,true,false],"draws":[89,124,81,234,757,1044,61,2110,1007,5025,6679,4578,19419]},
  {"version":"chicken-road-proposal-v2","difficulty":"hardcore","reason":"FINAL_LANE","lane":13,"nonce":"fixture-☃-🪶-hardcore-FINAL_LANE-57","commitment":"a20466a354a84472b2af25a651b05f48eb9796a32ee3251333a22b18d776eb95","survived":[true,true,true,true,true,true,true,true,true,true,true,true,true],"draws":[68,59,27,79,4,152,1049,742,1319,2151,2123,8322,1455]},
];
const SERVER = "0123456789abcdef".repeat(4);
const CLIENT = "f".repeat(64);
const vectorEvidence = (value) => {
  const crashed = value.reason === "COLLISION";
  const round = {
    id: `fixture-${value.version}-${value.difficulty}-${value.reason}`, status: crashed ? "CRASHED" : "CASHED",
    version: value.lane + (!crashed && value.reason !== "FINAL_LANE" ? 1 : 0),
    amount: 1000, difficulty: value.difficulty, lane: value.lane,
    multiplier_hundredths: crashed ? 0 : TABLES[value.difficulty][value.lane - 1],
    cashout_amount: 0, payout: crashed ? 0 : 10 * TABLES[value.difficulty][value.lane - 1],
    rules_version: value.version, fairness_version: "chicken-road-hmac-v1",
    multipliers_hundredths: TABLES[value.difficulty], server_seed_hash: value.commitment,
    client_seed: CLIENT, nonce: value.nonce, reason: value.reason, settled_at: "2026-09-28T12:00:00Z",
  };
  const proof = { round_id: round.id, server_seed: SERVER };
  for (const key of ["difficulty", "rules_version", "fairness_version", "multipliers_hundredths", "server_seed_hash", "client_seed", "nonce"]) proof[key] = round[key];
  return { proof, round };
};
const sample = () => vectorEvidence(VECTORS.find((value) => value.version.endsWith("v2") && value.difficulty === "medium" && value.reason === "PLAYER_CASHOUT"));

test.each(VECTORS.map((value) => [value.version, value.difficulty, value.reason, value]))(
  "%s %s %s matches the Python commitment and complete terminal lane sequence",
  async (_version, _difficulty, _reason, value) => {
    const { proof, round } = vectorEvidence(value);
    const verified = await verifyChickenRoadFairness(proof, round, webcrypto);
    expect(verified).toMatchObject({ roundId: round.id, checkedLanes: round.lane, payout: round.payout, status: round.status, commitment: value.commitment });
    expect(verified.lanes.map((lane) => lane.survived)).toEqual(value.survived.slice(0, value.lane));
    expect(verified.lanes.map((lane) => lane.draw)).toEqual(value.draws.slice(0, value.lane));
  },
);

test.each([
  ["round_id", "other-round"], ["server_seed", "0".repeat(64)], ["server_seed_hash", "0".repeat(64)],
  ["client_seed", "e".repeat(64)], ["nonce", "other-nonce"], ["difficulty", "hard"],
  ["rules_version", "chicken-road-proposal-v1"], ["fairness_version", "unknown"], ["multipliers_hundredths", [112]],
])("tampering with proof %s never reports verification", async (field, changed) => {
  const { proof, round } = sample();
  await expect(verifyChickenRoadFairness({ ...proof, [field]: changed }, round, webcrypto)).rejects.toThrow();
});

test.each([
  { status: "PLAYING" }, { lane: 0 }, { lane: 14 }, { lane: 1.5 }, { amount: 101 },
  { amount: "1000" }, { payout: 999999 }, { multiplier_hundredths: 999 }, { cashout_amount: 1280 },
  { settled_at: null }, { version: 999 }, { reason: "FINAL_LANE" }, { reason: "UNKNOWN" },
  { rules_version: "future" }, { fairness_version: "future" }, { multipliers_hundredths: [112] },
  { server_seed_hash: null }, { client_seed: "a".repeat(63) }, { nonce: "" },
])("incomplete or incompatible round %p is not verified", async (changes) => {
  const { proof, round } = sample();
  await expect(verifyChickenRoadFairness(proof, { ...round, ...changes }, webcrypto)).rejects.toThrow();
});

test("changing both the proof and bound table cannot bypass the independent rules archive", async () => {
  const { proof, round } = sample();
  const table = round.multipliers_hundredths.map((value, index) => index ? value : 111);
  await expect(verifyChickenRoadFairness({ ...proof, multipliers_hundredths: table }, { ...round, multipliers_hundredths: table }, webcrypto)).rejects.toThrow("payout table");
});

test("a claimed cash-out at a colliding lane fails outcome reconstruction", async () => {
  const { proof, round } = vectorEvidence(VECTORS.find((value) => value.version.endsWith("v2") && value.reason === "COLLISION"));
  const multiplier = round.multipliers_hundredths[round.lane - 1];
  await expect(verifyChickenRoadFairness(proof, { ...round, status: "CASHED", reason: "PLAYER_CASHOUT",
    version: round.lane + 1, multiplier_hundredths: multiplier, payout: round.amount * multiplier / 100 }, webcrypto)).rejects.toThrow("recorded outcome");
});

test("an earlier hidden collision invalidates a later claimed terminal collision", async () => {
  const { proof, round } = vectorEvidence(VECTORS.find((value) => value.reason === "COLLISION" && value.lane < 13));
  await expect(verifyChickenRoadFairness(proof, { ...round, lane: round.lane + 1, version: round.version + 1 }, webcrypto)).rejects.toThrow("recorded outcome");
});

test("full-width rejection sampling discards the biased tail and increments the canonical counter", async () => {
  const { proof, round } = sample();
  const range = BigInt(1) << BigInt(256);
  const limit = range - range % BigInt(112);
  const values = [range - BigInt(1), limit, BigInt(89), BigInt(0)];
  const sign = jest.fn(async () => Uint8Array.from(values.shift().toString(16).padStart(64, "0").match(/../g), (value) => parseInt(value, 16)).buffer);
  const crypto = { subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle), importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle), sign } };
  const verified = await verifyChickenRoadFairness(proof, round, crypto);
  expect(verified.lanes.map((lane) => lane.draw)).toEqual([89, 0]);
  expect(sign).toHaveBeenCalledTimes(4);
  expect(sign.mock.calls.map(([, , bytes]) => JSON.parse(Buffer.from(bytes).toString("ascii")).slice(4, 7)))
    .toEqual([[1, round.nonce, 0], [1, round.nonce, 1], [1, round.nonce, 2], [2, round.nonce, 0]]);
});

test("unsupported Web Crypto and rejected crypto operations are failures, not verification", async () => {
  const { proof, round } = sample();
  await expect(verifyChickenRoadFairness(proof, round, {})).rejects.toThrow("Web Crypto");
  await expect(verifyChickenRoadFairness(proof, round, { subtle: { digest: () => Promise.reject(new Error("Crypto unavailable")) } })).rejects.toThrow("Crypto unavailable");
});

test("conditional risks use the archived rules target and exact unchanged ladder", () => {
  for (const [difficulty, table] of Object.entries(TABLES)) {
    const old = chickenRoadCollisionChances("chicken-road-proposal-v1", difficulty, table);
    const current = chickenRoadCollisionChances("chicken-road-proposal-v2", difficulty, table);
    expect(old[0]).toEqual({ numerator: table[0] - 97, denominator: table[0] });
    expect(current[0]).toEqual({ numerator: table[0] - 90, denominator: table[0] });
    expect(old.slice(1)).toEqual(current.slice(1));
    table.forEach((value, index) => expect(current[index]).toEqual({ numerator: value - (index ? table[index - 1] : 90), denominator: value }));
  }
  expect(() => chickenRoadCollisionChances("future", "easy", TABLES.easy)).toThrow();
});
