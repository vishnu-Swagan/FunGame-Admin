/** Operator identity shown in the Chakri.Casino footer and legal pages. */
export const OPERATOR = {
  legalName: "Liberty Markets Ltd",
  companyNumber: "16905599",
  productName: "Chakri.Casino",
  tagline: "Play in the Light",
  country: "United Kingdom",
  addressLines: [
    "Unit 29, Highcroft Industrial Estate",
    "Enterprise Road, Horndean",
    "Waterlooville, Hampshire PO8 0BT",
    "United Kingdom",
  ],
  companyUrl: "https://libertymarketsltd.uk",
  productUrl: "https://chakri.casino",
};

export const AGE_AND_CHIPS = "VIRTUAL CHIPS ONLY · NO CASH VALUE · 18+ · PLAY RESPONSIBLY";

export function footerNav(signedIn) {
  return {
    Play: signedIn
      ? [
          { to: "/", label: "Home" },
          { to: "/games", label: "Games" },
          { to: "/chips", label: "Chips" },
          { to: "/chips/activity", label: "History" },
          { to: "/support", label: "Support" },
        ]
      : [
          { to: "/", label: "Welcome" },
          { to: "/register", label: "Create account" },
          { to: "/login", label: "Log in" },
          { to: "/about", label: "About" },
        ],
    Company: [
      { to: "/about", label: "About" },
      { to: "/contact", label: "Contact" },
      { to: "/fair-play", label: "Fair play" },
    ],
    Legal: [
      { to: "/terms", label: "Terms of use" },
      { to: "/privacy", label: "Privacy" },
      { to: "/cookies", label: "Cookies" },
      { to: signedIn ? "/responsible-play" : "/responsible-gaming", label: "Responsible play" },
    ],
  };
}
