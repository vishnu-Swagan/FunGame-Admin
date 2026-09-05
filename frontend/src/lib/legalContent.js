const envValue = (key) => {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const policyStatus = (envValue("REACT_APP_LEGAL_POLICY_STATUS") || "DRAFT").toUpperCase();

export const LEGAL_POLICY_VERSION = envValue("REACT_APP_LEGAL_POLICY_VERSION") || "2026.09-draft.1";
export const LEGAL_TERMS_VERSION = envValue("REACT_APP_TERMS_VERSION") || LEGAL_POLICY_VERSION;
export const LEGAL_PRIVACY_VERSION = envValue("REACT_APP_PRIVACY_VERSION") || LEGAL_POLICY_VERSION;
export const LEGAL_POLICY_EFFECTIVE_DATE = envValue("REACT_APP_LEGAL_POLICY_EFFECTIVE_DATE") || "Pending approval and publication";
export const LEGAL_POLICY_STATUS = policyStatus === "PUBLISHED" ? "PUBLISHED" : "DRAFT";

export const LEGAL_OPERATOR_CONFIG = Object.freeze({
  brandName: envValue("REACT_APP_OPERATOR_BRAND_NAME") || "Chakri.Casino",
  legalName: envValue("REACT_APP_OPERATOR_LEGAL_NAME"),
  companyNumber: envValue("REACT_APP_OPERATOR_COMPANY_NUMBER"),
  registeredOffice: envValue("REACT_APP_OPERATOR_REGISTERED_OFFICE"),
  regulatorName: envValue("REACT_APP_OPERATOR_REGULATOR_NAME"),
  licenceNumber: envValue("REACT_APP_OPERATOR_LICENCE_NUMBER"),
  licenceUrl: envValue("REACT_APP_OPERATOR_LICENCE_URL"),
  supportEmail: envValue("REACT_APP_OPERATOR_SUPPORT_EMAIL"),
  privacyEmail: envValue("REACT_APP_OPERATOR_PRIVACY_EMAIL"),
  complaintsEmail: envValue("REACT_APP_OPERATOR_COMPLAINTS_EMAIL"),
  adrName: envValue("REACT_APP_OPERATOR_ADR_NAME"),
  adrUrl: envValue("REACT_APP_OPERATOR_ADR_URL"),
  governingLaw: envValue("REACT_APP_OPERATOR_GOVERNING_LAW"),
});

export const REQUIRED_PUBLIC_OPERATOR_FIELDS = Object.freeze([
  "legalName",
  "companyNumber",
  "registeredOffice",
  "regulatorName",
  "licenceNumber",
  "licenceUrl",
  "supportEmail",
  "privacyEmail",
  "complaintsEmail",
  "governingLaw",
]);

export const missingOperatorFields = (config = LEGAL_OPERATOR_CONFIG) =>
  REQUIRED_PUBLIC_OPERATOR_FIELDS.filter((field) => !config[field]);

export const isLegalPublishingReady = (config = LEGAL_OPERATOR_CONFIG) =>
  LEGAL_POLICY_STATUS === "PUBLISHED"
  && LEGAL_POLICY_EFFECTIVE_DATE !== "Pending approval and publication"
  && missingOperatorFields(config).length === 0;

export const BALANCE_DEFINITIONS = Object.freeze({
  depositedCash:
    "Cash credited after the payment provider sends a verified confirmation. It is not a promotional reward.",
  withdrawableCash:
    "Cleared deposited cash and cash winnings that are eligible for withdrawal, less pending withdrawals and any specific lawful hold shown on the account.",
  restrictedBonus:
    "Promotional value kept separate from cash. Its use, expiry, contribution rules, and claim conditions come only from the bonus terms accepted by the player.",
  pendingReward:
    "A promotional reward that has not yet met its disclosed claim conditions and is not part of the withdrawable cash balance.",
  heldAmount:
    "Cash temporarily unavailable for a stated KYC, AML, fraud, sanctions, payment dispute, or legal review. A hold must have a reason and a review route.",
});

export const LEGAL_ROUTES = Object.freeze({
  terms: "/legal/terms",
  privacy: "/legal/privacy",
  cookies: "/legal/cookies",
  payments: "/legal/payments",
  withdrawals: "/legal/withdrawals",
  responsibleGambling: "/legal/responsible-gambling",
  amlKyc: "/legal/aml-kyc",
  bonuses: "/legal/bonuses",
  complaints: "/legal/complaints",
  restrictedTerritories: "/legal/restricted-territories",
  gameRules: "/legal/game-rules",
});

const section = (id, title, paragraphs, bullets = [], notice = null) => ({
  id,
  title,
  paragraphs,
  bullets,
  notice,
});

const metadata = (id, title, summary, lastReviewed = "2 September 2026", version = LEGAL_POLICY_VERSION) => ({
  id,
  version,
  status: LEGAL_POLICY_STATUS,
  effectiveDate: LEGAL_POLICY_EFFECTIVE_DATE,
  lastReviewed,
  title,
  summary,
});

export const LEGAL_DOCUMENTS = Object.freeze({
  terms: {
    ...metadata(
      "CC-TERMS",
      "Terms of Service",
      "The core agreement for account access, real-money play, payments, promotions, and account closure.",
      "2 September 2026",
      LEGAL_TERMS_VERSION
    ),
    sections: [
      section("scope", "Scope and acceptance", [
        "These Terms govern access to Chakri.Casino and form part of the agreement between the player and the legal operator identified in the Company Information panel.",
        "Creating an account, depositing, or placing a real-money wager requires acceptance of the version presented at that time. A consent record should include the policy ID, version, timestamp, jurisdiction, and method of acceptance.",
        "If a product-specific rule conflicts with these Terms, the more specific rule applies only to that product and only to the extent permitted by applicable law.",
      ]),
      section("eligibility", "Eligibility and location", [
        "Real-money services are available only to adults who meet the minimum legal age in their location and are physically present in a permitted territory.",
        "The player is responsible for providing accurate information. Chakri.Casino may use age, identity, address, sanctions, payment, and location checks before allowing deposits or play.",
      ], [
        "One account per player unless the operator gives written approval.",
        "Do not use the service for another person or allow another person to use your account.",
        "Do not use a VPN, proxy, location-spoofing tool, or false document to bypass eligibility controls.",
      ]),
      section("account", "Account security", [
        "Keep login credentials and authentication codes private. Tell support promptly if an account or payment method may have been compromised.",
        "The operator may suspend access while investigating suspected account takeover. Legitimate cleared funds remain subject to the withdrawal and verification process described in the Withdrawal Policy.",
      ]),
      section("balances", "Cash and promotional balances", [
        "The wallet must identify deposited cash, withdrawable cash, restricted bonus, pending rewards, pending withdrawals, and documented holds separately.",
        "A promotional wagering condition does not create a blanket restriction on withdrawal of cleared cash. Any restriction must apply to the specific promotional value under the bonus terms accepted before participation.",
      ], [], "Financial figures shown in the wallet and transaction history are server authoritative. Contact support if a balance or transaction appears incorrect."),
      section("payments", "Deposits and payments", [
        "Deposits are credited only after an approved payment provider sends a verified server confirmation. A browser redirect or receipt image does not prove settlement.",
        "Use only a payment method you are authorized to use. Deposits may be declined, delayed, reversed, or reviewed where required by payment, fraud, sanctions, or legal controls.",
      ]),
      section("play", "Wagers and game results", [
        "A wager is accepted only when the server records it and returns confirmation. The game-specific rules describe stake limits, result generation, settlement, disconnections, cancellations, and void rounds.",
        "Do not exploit software faults, collude, automate play where prohibited, interfere with a game, or obtain an unfair advantage. Genuine errors are handled under the published game and settlement rules, subject to applicable law.",
      ]),
      section("withdrawals", "Withdrawals", [
        "A player may request withdrawal of available withdrawable cash, subject to identity, ownership, sanctions, fraud, payment dispute, and other checks required by law.",
        "Where a cash amount is held, the account should show the category of hold, the amount affected, and how to request support or review. Bonus conditions must not be presented as a generic cash withdrawal hold.",
      ]),
      section("promotions", "Bonuses and rewards", [
        "Participation in a promotion must be optional. Material terms, including reward value, qualifying play, game contribution, maximum stake, expiry, withdrawal consequences, and claim process, must be shown before opt-in.",
        "Each accepted promotion keeps its original version. Later campaign edits do not replace the terms already accepted for an active mission.",
      ]),
      section("safer-play", "Responsible gambling", [
        "Players can use available limits, time-outs, self-exclusion, account closure, and support tools. Self-exclusion blocks new deposits, wagering, and bonus participation, but it does not remove the right to withdraw legitimate cleared funds.",
      ]),
      section("suspension", "Suspension and closure", [
        "The operator may restrict or close an account for eligibility failure, legal requirements, security, payment disputes, fraud indicators, rule breaches, or safer-gambling intervention. The reason and available review route should be provided where the law permits.",
        "Account closure does not automatically confiscate legitimate cleared cash. Any deduction, void, or recovery must have a documented contractual and lawful basis.",
      ]),
      section("availability", "Service availability", [
        "Internet, device, supplier, payment, and maintenance issues can interrupt service. Confirmed server records determine whether a wager was accepted or settled.",
        "Nothing in these Terms excludes rights or remedies that cannot lawfully be excluded.",
      ]),
      section("changes", "Policy changes", [
        "Material changes must be versioned and communicated before they apply. Where fresh consent is required, affected services remain unavailable until that consent is recorded.",
        "Changes do not rewrite completed transactions or previously accepted promotional terms unless the law requires it and the player is informed.",
      ]),
      section("law-complaints", "Governing terms and complaints", [
        "The governing law, operator identity, regulator, and any independent dispute service applicable to the player must appear in the Company Information panel before publication.",
        "Complaints are handled under the Complaints Policy. This does not limit a player's right to contact an applicable regulator, dispute service, court, or consumer authority.",
      ]),
    ],
  },

  privacy: {
    ...metadata(
      "CC-PRIVACY",
      "Privacy Notice",
      "How account, identity, payment, gameplay, device, and support information is used and protected.",
      "2 September 2026",
      LEGAL_PRIVACY_VERSION
    ),
    sections: [
      section("controller", "Who controls personal data", [
        "The data controller is the legal operator identified in the Company Information panel. Its privacy contact and registered address must be published before this notice becomes effective.",
      ]),
      section("data", "Information we collect", [
        "We may collect information supplied during registration and verification, records created through use of the service, and information received from approved service providers.",
      ], [
        "Identity and contact details, date of birth, address, and verification evidence.",
        "Payment tokens, transaction references, wallet entries, and withdrawal records. Full card or bank credentials should remain with approved payment providers where possible.",
        "Wagers, game results, session activity, limits, exclusions, and promotion participation.",
        "Device, security, IP address, approximate or verified location, cookie, and fraud-risk signals.",
        "Messages, complaints, support records, and consent history.",
      ]),
      section("purposes", "Why information is used", [
        "Personal data may be used to provide accounts and games, process transactions, verify eligibility, meet legal duties, prevent fraud and financial crime, protect service security, provide support, resolve disputes, and operate consented communications.",
        "The operator must document the applicable legal basis for each purpose in the territories it serves. Optional marketing and non-essential tracking require the consent or choice required by local law.",
      ]),
      section("decisions", "Risk checks and automated decisions", [
        "Automated tools may flag identity, location, payment, fraud, collusion, or safer-gambling risk. A device signal must not be the sole reason for a referral-reward rejection or adverse fraud decision.",
        "Where applicable law provides a right to human review, the player can request it through the published privacy or complaints contact.",
      ]),
      section("sharing", "Who receives information", [
        "Information may be shared with identity and age-verification services, payment providers, banks, game and hosting suppliers, analytics and security vendors, professional advisers, dispute services, regulators, law enforcement, and other recipients where lawfully required.",
        "Providers receive only the information needed for their role and must be governed by appropriate data-processing and security terms.",
      ]),
      section("transfers", "International transfers", [
        "If information is processed outside the player's country, the operator must use the transfer mechanism and safeguards required by applicable data-protection law and explain how to request more information.",
      ]),
      section("retention", "How long information is kept", [
        "Records are kept only as long as needed for account services and applicable legal, tax, anti-money-laundering, safer-gambling, dispute, security, and audit requirements.",
        "Retention periods must be documented by data category. Closing an account does not require deletion where keeping a record remains legally necessary.",
      ]),
      section("rights", "Privacy rights", [
        "Depending on location, a player may have rights to access, correct, delete, restrict, object to, or receive a copy of personal data, withdraw consent, and complain to a data-protection authority.",
        "Requests may require identity verification. The response will explain any lawful exception that prevents part of a request being completed.",
      ]),
      section("security", "Security", [
        "Administrative, technical, and organizational safeguards are used to protect information. No service can guarantee absolute security, so suspected compromise should be reported promptly.",
      ]),
      section("contact", "Privacy contact", [
        "The privacy email and postal contact in the Company Information panel are the channels for privacy requests. They must be completed before publication.",
      ]),
    ],
  },

  cookies: {
    ...metadata(
      "CC-COOKIES",
      "Cookie Notice",
      "A plain-language explanation of cookies, local storage, consent, and player choices."
    ),
    sections: [
      section("what", "What these technologies are", [
        "Cookies and similar technologies store or read information on a browser or device. This notice also covers local storage, session storage, and comparable identifiers used by the website or app.",
      ]),
      section("categories", "Categories", [
        "Each deployed technology must be listed in the live consent manager with its provider, purpose, duration, and category.",
      ], [
        "Strictly necessary: authentication, security, load balancing, payment flow integrity, and saved privacy choices.",
        "Preferences: language, display settings, and optional experience choices.",
        "Analytics: service performance and aggregated usage measurement.",
        "Marketing: campaign measurement or personalized advertising where permitted and consented.",
      ]),
      section("choice", "Your choices", [
        "Non-essential technologies must not run before the consent required in the player's location. Rejecting optional cookies must be as straightforward as accepting them.",
        "A player can reopen cookie settings and change optional choices. Withdrawal of consent applies going forward and does not invalidate earlier lawful processing.",
      ]),
      section("browser", "Browser and device controls", [
        "Browsers can block or delete cookies. Blocking strictly necessary storage may prevent secure sign-in, payment completion, or saved privacy choices.",
      ]),
      section("changes", "Changes to this notice", [
        "The version and effective date change when the deployed technology list or a material use changes. Fresh consent is requested where required.",
      ]),
    ],
  },

  payments: {
    ...metadata(
      "CC-PAYMENTS",
      "Payments Policy",
      "How deposits are initiated, verified, credited, reviewed, reversed, and shown in the wallet."
    ),
    sections: [
      section("methods", "Available payment methods", [
        "Methods, currencies, minimums, maximums, fees, and expected processing times must be shown before confirmation. Availability can depend on the player's verified location and account status.",
        "Use only a payment instrument held in the player's own name or one the player is authorized to use.",
      ]),
      section("credit", "When a deposit is credited", [
        "A deposit becomes account cash only after the provider sends a verified server-to-server confirmation and the transaction passes duplicate and integrity checks.",
        "A browser return page, screenshot, email, or client request cannot credit a wallet. Pending payments remain marked pending until a final provider event is received.",
      ]),
      section("balances", "How money appears", [
        "Deposited cash is separate from restricted bonus and pending promotional rewards. The wallet should show the source, amount, status, transaction reference, and timestamp for each movement.",
      ]),
      section("failed", "Failed, delayed, and duplicate payments", [
        "A failed or abandoned attempt is not credited. Duplicate provider notifications must return the original outcome without crediting money twice.",
        "Support may request a provider reference to investigate a delay. Never send a full card number, security code, password, or one-time authentication code to support.",
      ]),
      section("reversals", "Reversals and disputes", [
        "A bank or provider reversal, chargeback, or confirmed unauthorized payment may lead to a corresponding wallet correction and account review. The transaction history should identify the affected payment and adjustment.",
        "A dispute is not permission to confiscate unrelated cleared funds. Any recovery must follow the contract and applicable law.",
      ]),
      section("checks", "Payment checks", [
        "Identity, payment ownership, sanctions, fraud, source-of-funds, and affordability or safer-gambling checks may occur before or after a payment attempt where required.",
      ]),
    ],
  },

  withdrawals: {
    ...metadata(
      "CC-WITHDRAWALS",
      "Withdrawal Policy",
      "Eligibility, verification, processing, holds, cancellations, fees, and bonus treatment for withdrawals."
    ),
    sections: [
      section("available", "What can be withdrawn", [
        "Available withdrawable cash can be requested at any time, subject to the checks and transaction limits disclosed for the player's location.",
        "There is no blanket requirement to wager deposited cash before requesting it. Restricted promotional value and pending rewards are shown separately and are not included in withdrawable cash until their terms are completed and the server confirms the resulting status.",
      ], [], "A request that exceeds withdrawable cash should show the requested amount, available cash, restricted bonus, held amount, reason codes, and support options."),
      section("method", "Withdrawal method", [
        "Where practical and required by risk controls, funds are returned to the verified payment method used to deposit. An alternative verified method may be required where the original method cannot receive withdrawals.",
        "Third-party accounts and anonymous destinations are not accepted where ownership cannot be verified.",
      ]),
      section("verification", "Verification and review", [
        "Identity, age, address, payment ownership, sanctions, source of funds, fraud, and safer-gambling checks should be completed as early as reasonably possible and not postponed solely until withdrawal.",
        "If more information is required, the player should receive a clear request, secure submission route, and current withdrawal status.",
      ]),
      section("holds", "Specific holds", [
        "A withdrawal or cash amount may be paused for a documented KYC, AML, sanctions, fraud, payment dispute, court, regulator, or legal reason. The account should display the category, affected amount, review status, and support route where disclosure is permitted.",
        "An active bonus mission is not by itself a generic withdrawal hold.",
      ]),
      section("bonus", "Effect on an active bonus", [
        "If the accepted bonus terms state that withdrawing cash forfeits an unearned bonus, the player must be shown the exact bonus and consequence before confirming. The player can continue without the bonus where that option is offered.",
        "Forfeiting an unearned bonus does not forfeit deposited cash or cash winnings.",
      ]),
      section("timing", "Processing times, fees, and status", [
        "The withdrawal screen must show any operator processing estimate, provider estimate, fee, currency conversion, minimum, and maximum before submission. Estimates are not guarantees where a bank, provider, or lawful review controls timing.",
        "Status updates and a transaction reference should remain available in activity history.",
      ]),
      section("cancel", "Cancellation and complaints", [
        "A player can cancel only while the request status permits it. The service must not pressure a player to reverse a withdrawal or resume gambling.",
        "A delayed, declined, or disputed withdrawal can be raised through the Complaints Policy.",
      ]),
    ],
  },

  responsibleGambling: {
    ...metadata(
      "CC-RESPONSIBLE-GAMBLING",
      "Responsible Gambling Policy",
      "Practical tools and protections for keeping gambling within personal limits or stopping completely."
    ),
    sections: [
      section("principles", "Play with control", [
        "Gambling involves the risk of losing money. It should not be treated as income, a way to recover losses, or a solution to financial difficulty.",
        "Set a budget and time limit before playing. Do not borrow to gamble and do not continue because of earlier losses.",
      ]),
      section("tools", "Account tools", [
        "Available controls may include deposit limits, loss limits, wager limits, session reminders, time-outs, marketing preferences, and self-exclusion. The account should show when a restriction starts and whether an increase has a cooling-off delay.",
      ]),
      section("break", "Time-out and self-exclusion", [
        "A time-out prevents gambling for the selected period. Self-exclusion prevents new deposits, wagering, and bonus participation for the applicable period and should remove promotional marketing where required.",
        "These controls do not block withdrawal of legitimate cleared funds. Account verification may still be required to protect the player and meet legal duties.",
      ]),
      section("intervention", "Safer-gambling review", [
        "The operator may review patterns that suggest harm, contact the player, set restrictions, pause gambling, or close access. Decisions should use proportionate evidence and be recorded for audit.",
      ]),
      section("support", "Getting help", [
        "If gambling is causing stress, financial difficulty, secrecy, conflict, or loss of control, stop playing and contact an independent support service available in your country.",
        "Local crisis or emergency services should be contacted where there is immediate danger. The live page must publish relevant independent support links for each permitted territory.",
      ]),
      section("minors", "Protecting minors", [
        "Real-money gambling is for eligible adults only. Keep login and payment details private, sign out on shared devices, and use device-level parental controls where appropriate.",
      ]),
    ],
  },

  amlKyc: {
    ...metadata(
      "CC-AML-KYC",
      "Identity and Financial Crime Policy",
      "How identity, payment ownership, sanctions, fraud, and source-of-funds checks protect players and the service."
    ),
    sections: [
      section("why", "Why checks are required", [
        "Checks help confirm age, identity, location, payment ownership, and account control, and help prevent money laundering, terrorist financing, sanctions breaches, fraud, collusion, and misuse of the service.",
      ]),
      section("information", "Information we may request", [
        "Depending on risk and applicable law, the operator may request identity and address documents, a live identity check, payment ownership evidence, occupation, source of funds, source of wealth, transaction purpose, or an explanation of account activity.",
        "Requests should explain what is needed, why it is needed where disclosure is permitted, how to submit it securely, and any deadline.",
      ]),
      section("timing", "When checks happen", [
        "Verification may occur at registration, before deposit, before gambling, when limits are reached, after a material account change, during ongoing monitoring, or before withdrawal where an unresolved requirement remains.",
        "Checks should not be deliberately delayed until a player seeks to withdraw.",
      ]),
      section("review", "Account review", [
        "During a review, specific activities or funds may be restricted where proportionate and lawful. The player should receive a status and support route unless disclosure would undermine a legal or security process.",
      ]),
      section("outcomes", "Possible outcomes", [
        "Outcomes may include successful verification, a request for more information, transaction limits, rejection of a payment, a documented hold, account restriction or closure, or a report to an authority where required.",
        "A risk flag is not automatically proof of wrongdoing. Decisions should consider relevant evidence and provide review or appeal options where permitted.",
      ]),
      section("records", "Records and privacy", [
        "Verification and monitoring records are handled under the Privacy Notice and retained for the period required by applicable law and documented policy.",
      ]),
    ],
  },

  bonuses: {
    ...metadata(
      "CC-BONUSES",
      "Bonus and Reward Terms",
      "How optional offers, wagering missions, referral rewards, expiry, claims, and bonus restrictions work."
    ),
    sections: [
      section("optional", "Optional participation", [
        "A deposit offer or reward mission is optional. Players must be able to continue without a bonus where a bonus is presented during payment.",
        "The offer review must show the campaign and terms version, eligible player and territory, deposit amount, reward, wagering target, game contribution rates, maximum qualifying stake, expiry, claim process, and withdrawal consequence before acceptance.",
      ]),
      section("balances", "Separate bonus balance", [
        "Restricted bonus and pending rewards are not deposited cash. They are displayed separately from withdrawable cash, with the mission or campaign that controls them.",
        "Promotional conditions apply only to the relevant reward and any derived amount identified in the accepted terms. They do not create a blanket withdrawal condition for cleared cash.",
      ]),
      section("progress", "Qualifying play", [
        "Only server-confirmed settled stakes count toward a wagering target. Winnings, losses, button presses, cancelled wagers, refunded wagers, and void rounds do not add turnover unless the accepted terms lawfully and expressly state otherwise.",
        "Each eligible game can have a stated contribution percentage and maximum qualifying stake. Pending settlements are shown separately and do not become settled progress until the game result is final.",
      ]),
      section("expiry", "Expiry, pause, and forfeiture", [
        "The absolute deadline, time zone, and remaining time must be visible. A mission can expire or pause for review only under its accepted rules and server-authoritative status.",
        "Any rule that an unearned bonus is forfeited following withdrawal must be legally approved, disclosed before opt-in, and confirmed again before the player proceeds. Cleared cash is not forfeited.",
      ]),
      section("claim", "Claims", [
        "A reward can be claimed only after the server marks it claimable. Claim requests are idempotent so retries cannot issue the same reward more than once.",
        "The completed claim should show the reward destination, transaction or receipt ID, status, and timestamp.",
      ]),
      section("referrals", "Referral rewards", [
        "Referral rewards use a separate consumer invite system. Tasks, fixed reward values, verification periods, caps, rejection reasons, privacy information, and appeal routes must be shown before sharing.",
        "Sharing requires an explicit player action. Contact access is not automatic. Self-referral, duplicate accounts, and manipulated verification can cause a task to be rejected after proportionate review.",
      ]),
      section("fairness", "Offer fairness", [
        "Material terms cannot be hidden in a tooltip or changed retroactively for an accepted mission. An activated campaign must be versioned, jurisdiction-approved, capped, and auditable.",
        "Randomized rewards remain unavailable unless separately approved and accompanied by disclosed odds, award limits, a versioned probability table, and an auditable secure draw.",
      ]),
    ],
  },

  complaints: {
    ...metadata(
      "CC-COMPLAINTS",
      "Complaints and Disputes Policy",
      "How to raise an issue, what information to include, response stages, escalation, and independent review."
    ),
    sections: [
      section("contact", "How to complain", [
        "Use the complaints contact in the Company Information panel and state that the message is a formal complaint. The dedicated address must be published before this policy becomes effective.",
      ], [
        "Account username or registered contact detail.",
        "Transaction, payment, withdrawal, wager, or game reference where relevant.",
        "Date and approximate time, including time zone.",
        "What happened, the outcome requested, and any supporting evidence.",
      ]),
      section("acknowledgment", "Acknowledgment and investigation", [
        "The operator should acknowledge the complaint, assign a reference, protect disputed records, and explain the expected response schedule required in the player's jurisdiction.",
        "The investigation may review account, game, payment, identity, support, consent, and audit records. Sensitive documents must use an approved secure channel.",
      ]),
      section("response", "Response", [
        "The written response should summarize the issue, relevant evidence, decision, remedy if any, and the next escalation step. A reason may be limited where law or security requirements prevent full disclosure.",
      ]),
      section("escalation", "Escalation and independent review", [
        "A player who remains dissatisfied can request the next internal review stage. When the internal process is complete, the operator must provide any regulator, alternative dispute resolution service, ombudsman, or consumer route that applies to the player's location.",
        "The applicable independent service and time limits must be completed in the Company Information panel before publication.",
      ]),
      section("urgent", "Urgent account safety", [
        "Suspected account takeover, unauthorized payment, or immediate gambling-harm concerns should be reported through the fastest available support channel rather than waiting for the ordinary complaint timetable.",
      ]),
      section("records", "Records and retaliation", [
        "Complaint records are retained under the Privacy Notice and applicable legal requirements. A good-faith complaint does not remove a player's rights or justify retaliation.",
      ]),
    ],
  },

  restrictedTerritories: {
    ...metadata(
      "CC-RESTRICTED-TERRITORIES",
      "Restricted Territories Policy",
      "Location eligibility, travel, geolocation checks, and the live territory allowlist."
    ),
    sections: [
      section("availability", "Where real-money services are available", [
        "Real-money registration, deposits, gambling, and promotions are available only in territories expressly enabled by the operator's verified licence scope and current legal assessment.",
        "The live product must publish the current permitted-territory list and any local product limits. No territory is presumed permitted because the website is technically reachable there.",
      ], [], "This draft intentionally contains no invented country allowlist. A verified jurisdiction configuration is required before publication."),
      section("checks", "Location checks", [
        "The service may use IP address, device location, address, payment country, identity records, and other proportionate signals to confirm eligibility.",
        "VPNs, proxies, remote-access software, emulators, location spoofing, and false information must not be used to bypass a restriction.",
      ]),
      section("travel", "Travel and relocation", [
        "An existing account may be unable to deposit, gamble, or join promotions while the player is physically present in a restricted location. Moving or travelling can require fresh verification.",
        "A location restriction does not by itself confiscate legitimate cleared funds. The operator will provide an available withdrawal or support process, subject to applicable checks and law.",
      ]),
      section("changes", "Changes to territory status", [
        "Legal and licence scope can change. Access may be restricted promptly where required, and affected players should receive information about account access, unresolved wagers, balances, and withdrawals.",
      ]),
      section("questions", "Check before playing", [
        "Players should confirm the territory shown in their account and contact support before depositing if their location or residency is unclear.",
      ]),
    ],
  },

  gameRules: {
    ...metadata(
      "CC-GAME-RULES",
      "General Game Rules",
      "Rules common to real-money games, including acceptance, results, settlement, interruptions, errors, and return information."
    ),
    sections: [
      section("specific", "Game-specific rules", [
        "Each game must display its objective, valid actions, stake range, paytable or payout formula, result process, settlement conditions, return information, and any special interruption rule before real-money play.",
        "These general rules apply alongside the game-specific rules. If there is a conflict, the specific rule applies to that game, subject to applicable law.",
      ]),
      section("acceptance", "Wager acceptance", [
        "Selecting a stake or pressing a button is not by itself an accepted wager. A wager is accepted only when the authoritative server validates the request, records the funding allocation, and returns confirmation.",
        "Rejected or timed-out requests must not deduct funds. Repeated client requests with the same idempotency identity must not create duplicate wagers.",
      ]),
      section("funding", "Funding source and refunds", [
        "Every stake records whether it used cash, restricted bonus, or a disclosed combination. A void or refund returns value to the same source buckets used by the original stake.",
        "Payout restrictions follow the disclosed source policy. The transaction history should provide the authoritative balance movements.",
      ]),
      section("results", "Results and settlement", [
        "The authoritative game service determines and records the result. A result is final only when the server marks the wager settled, void, cancelled, or refunded.",
        "Animation, sound, local display timing, or a network delay does not override the server record. Support can investigate a result using its wager reference.",
      ]),
      section("interruptions", "Disconnections and interruptions", [
        "If the device disconnects after acceptance, the server continues or settles the wager under that game's rules. Reopening the game or activity history should show the recorded outcome.",
        "If acceptance cannot be confirmed, the player should check activity history before trying again.",
      ]),
      section("errors", "Malfunctions and corrections", [
        "Technical errors are investigated using server, game supplier, wallet, and audit records. Corrections must be traceable, proportionate, and consistent with the published rule and applicable law.",
        "A generic malfunction statement does not permit arbitrary confiscation or cancellation.",
      ]),
      section("rng", "Randomness, fairness, and return", [
        "Games using random outcomes must use the approved and tested result method disclosed for that game. Supplier, test-lab, certificate, and licence disclosures must be accurate and current before publication.",
        "Theoretical return to player is calculated over a very large number of wagers and does not predict a single session. Recent wins or losses do not make a future random result due.",
      ]),
      section("crash", "Crash and multiplier games", [
        "For a crash-style game, the specific rules must explain when the round begins, when bets close, how the multiplier is generated, how cash-out requests are accepted, what happens at the crash point, and how disconnections are handled.",
        "Visual aircraft movement and multiplier animation are presentation only. The authoritative server event determines accepted cash-out and settlement.",
      ]),
      section("help", "Questions and disputes", [
        "Keep the wager reference and contact support if a game result or balance movement appears incorrect. Formal disputes follow the Complaints Policy.",
      ]),
    ],
  },
});

export const LEGAL_DOCUMENT_ORDER = Object.freeze([
  "terms",
  "privacy",
  "cookies",
  "payments",
  "withdrawals",
  "responsibleGambling",
  "amlKyc",
  "bonuses",
  "complaints",
  "restrictedTerritories",
  "gameRules",
]);

export const getLegalDocument = (slug) => LEGAL_DOCUMENTS[slug] || null;
