/** Operator identity shown in the Chakri.Casino footer and legal pages. */
export const OPERATOR = {
  legalName: "SKY-AMC LIMITED",
  companyNumber: "81331404",
  productName: "Chakri.Casino",
  tagline: "Play in the Light",
  country: "Hong Kong",
  addressLines: [
    "Unit 1603, 16th Floor, The L. Plaza",
    "367–375 Queen’s Road Central",
    "Sheung Wan",
    "Hong Kong",
  ],
  companyUrl: "https://sky-amc.com",
  productUrl: "https://chakri.casino",
};

export const AGE_AND_CHIPS = "18+ · PLAY RESPONSIBLY · BONUS AND WITHDRAWAL TERMS APPLY";

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
      { to: "/legal/bonuses", label: "Bonus terms" },
      { to: "/terms", label: "Terms of use" },
      { to: "/privacy", label: "Privacy" },
      { to: "/cookies", label: "Cookies" },
      { to: signedIn ? "/responsible-play" : "/responsible-gaming", label: "Responsible play" },
    ],
  };
}
