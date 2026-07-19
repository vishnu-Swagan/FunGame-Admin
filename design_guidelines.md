{
  "brand": {
    "product_name": "FunGame",
    "positioning": "Premium amusement/casino-style play-chip platform (PWA-feel). No real money.",
    "non_cash_disclaimer": {
      "required_copy": "PLAY CHIPS — NO CASH VALUE",
      "placement_rules": [
        "Every screen must show the disclaimer in a consistent, non-ignorable place.",
        "Player-facing screens: show in the top app header (right side) OR as a thin sticky banner under the header.",
        "Auth/onboarding: show under the primary CTA area.",
        "Admin: show in the top bar (right) + in Settings page footer.",
        "Use small caps + tracking for legibility; never hide behind a tooltip."
      ],
      "tailwind_example": "text-[11px] tracking-[0.18em] uppercase text-white/70"
    },
    "brand_attributes": [
      "premium-modern entertainment",
      "trustworthy (explicit play-chip-only)",
      "fast + tactile (60fps motion, thumb-first)",
      "glassy layered depth (not noisy)",
      "distinct game identities within one system"
    ]
  },

  "visual_personality": {
    "style_fusion": [
      "Luxury midnight casino (deep navy/black + brushed gold)",
      "Sci‑fi arcade accents (electric cyan + emerald + controlled magenta)",
      "Layered glass surfaces with inner highlights (2.5D feel)",
      "Swiss-style hierarchy for readability (tight system, generous spacing)",
      "Bento rails + carousels for lobby discovery"
    ],
    "do_not": [
      "No wood textures.",
      "No cluttered paytables.",
      "No tiny labels.",
      "No inconsistent button styles.",
      "No purple-heavy gradients; magenta is allowed only as a small accent (badges/glints), not as large gradients.",
      "No copied assets from reference site; all key art must be original CSS/SVG compositions."
    ]
  },

  "typography": {
    "google_fonts": {
      "display": {
        "family": "Gloock",
        "usage": "Game titles only (cards + detail hero).",
        "fallback": "ui-serif, Georgia, serif",
        "weights": ["400"]
      },
      "ui": {
        "family": "Manrope",
        "usage": "All UI controls, body, admin tables.",
        "fallback": "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
        "weights": ["400", "500", "600", "700"]
      }
    },
    "tailwind_font_tokens": {
      "font-display": "font-[\"Gloock\"]",
      "font-ui": "font-[\"Manrope\"]"
    },
    "type_scale": {
      "h1": "text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight",
      "h2": "text-base md:text-lg text-white/80",
      "section_title": "text-lg font-semibold tracking-tight",
      "card_title": "text-base font-semibold",
      "body": "text-sm md:text-base leading-relaxed text-white/80",
      "caption": "text-xs text-white/60",
      "disclaimer": "text-[11px] tracking-[0.18em] uppercase text-white/70"
    },
    "numbers": {
      "chip_balance": "tabular-nums",
      "admin_tables": "tabular-nums"
    }
  },

  "color_system": {
    "notes": [
      "Dark theme only: deep midnight navy/black base.",
      "Gold is the primary metallic accent; cyan/emerald/magenta are secondary accents used sparingly.",
      "Gradients are decorative only and must follow the GRADIENT RESTRICTION RULE (max 20% viewport)."
    ],
    "tokens_css_variables": {
      "implementation_location": "/app/frontend/src/index.css",
      "replace_dark_palette": true,
      "css": "/* FunGame dark-only tokens (HSL channels) */\n@layer base {\n  :root {\n    --background: 222 55% 6%;        /* midnight navy */\n    --foreground: 210 40% 98%;\n\n    --card: 222 45% 9%;\n    --card-foreground: 210 40% 98%;\n\n    --popover: 222 45% 9%;\n    --popover-foreground: 210 40% 98%;\n\n    --primary: 43 92% 56%;           /* brushed gold */\n    --primary-foreground: 222 55% 8%;\n\n    --secondary: 222 30% 14%;\n    --secondary-foreground: 210 40% 98%;\n\n    --muted: 222 28% 12%;\n    --muted-foreground: 215 20% 72%;\n\n    --accent: 222 28% 12%;\n    --accent-foreground: 210 40% 98%;\n\n    --destructive: 0 72% 52%;\n    --destructive-foreground: 210 40% 98%;\n\n    --border: 222 22% 18%;\n    --input: 222 22% 18%;\n    --ring: 43 92% 56%;\n\n    /* Extra brand channels (use via arbitrary values or custom utilities) */\n    --gold-2: 38 78% 48%;            /* deeper gold */\n    --cyan: 190 92% 55%;\n    --emerald: 152 62% 46%;\n    --magenta: 325 78% 58%;\n\n    --radius: 14px;\n  }\n\n  /* Force dark-only: keep .dark aligned with :root */\n  .dark {\n    --background: 222 55% 6%;\n    --foreground: 210 40% 98%;\n    --card: 222 45% 9%;\n    --card-foreground: 210 40% 98%;\n    --popover: 222 45% 9%;\n    --popover-foreground: 210 40% 98%;\n    --primary: 43 92% 56%;\n    --primary-foreground: 222 55% 8%;\n    --secondary: 222 30% 14%;\n    --secondary-foreground: 210 40% 98%;\n    --muted: 222 28% 12%;\n    --muted-foreground: 215 20% 72%;\n    --accent: 222 28% 12%;\n    --accent-foreground: 210 40% 98%;\n    --destructive: 0 72% 52%;\n    --destructive-foreground: 210 40% 98%;\n    --border: 222 22% 18%;\n    --input: 222 22% 18%;\n    --ring: 43 92% 56%;\n  }\n}\n"
    },
    "semantic_usage": {
      "background": "bg-background",
      "surface": "bg-card/70 backdrop-blur-md",
      "surface_strong": "bg-card",
      "text_primary": "text-foreground",
      "text_secondary": "text-white/70",
      "gold_accent": "text-primary",
      "borders": "border-border/70",
      "focus_ring": "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
    },
    "status_colors": {
      "coming_soon": {
        "bg": "bg-[hsl(var(--cyan)/0.14)]",
        "border": "border-[hsl(var(--cyan)/0.35)]",
        "text": "text-[hsl(var(--cyan))]"
      },
      "pending": {
        "bg": "bg-[hsl(var(--emerald)/0.14)]",
        "border": "border-[hsl(var(--emerald)/0.35)]",
        "text": "text-[hsl(var(--emerald))]"
      },
      "maintenance": {
        "bg": "bg-[hsl(var(--magenta)/0.12)]",
        "border": "border-[hsl(var(--magenta)/0.32)]",
        "text": "text-[hsl(var(--magenta))]"
      }
    }
  },

  "gradients_and_texture": {
    "rules": {
      "gradient_restriction_rule": [
        "NEVER use dark/saturated gradient combos (e.g., purple/pink) on any UI element.",
        "NEVER let gradients cover more than 20% of the viewport.",
        "NEVER apply gradients to text-heavy content or reading areas.",
        "NEVER use gradients on small UI elements (<100px width).",
        "NEVER stack multiple gradient layers in the same viewport.",
        "ENFORCEMENT: If gradient area exceeds 20% of viewport OR affects readability, THEN use solid colors."
      ]
    },
    "allowed_gradients": {
      "hero_backdrop": {
        "description": "Top-of-screen aurora strip behind header/hero only (10–18vh).",
        "css": "background: radial-gradient(900px 240px at 20% 0%, rgba(0, 229, 255, 0.18), transparent 60%), radial-gradient(700px 220px at 80% 10%, rgba(34, 197, 94, 0.14), transparent 55%), radial-gradient(600px 220px at 55% 0%, rgba(255, 199, 64, 0.12), transparent 60%);"
      },
      "chip_glint": {
        "description": "Tiny highlight on chip edges only (not full chip fill).",
        "css": "background: linear-gradient(135deg, rgba(255, 214, 102, 0.55), rgba(255, 214, 102, 0));"
      }
    },
    "noise_overlay": {
      "description": "Subtle grain to avoid flat glass. Use CSS-only noise (no external images).",
      "css": "/* Add once on app shell */\n.fg-noise::before {\n  content: \"\";\n  position: absolute;\n  inset: 0;\n  pointer-events: none;\n  opacity: 0.06;\n  mix-blend-mode: overlay;\n  background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E\");\n}\n"
    }
  },

  "layout_and_grid": {
    "app_shell": {
      "mobile_first": true,
      "max_width": "max-w-[430px] md:max-w-[520px] lg:max-w-[1100px]",
      "centering": "mx-auto",
      "safe_area": "pb-[calc(88px+env(safe-area-inset-bottom))]",
      "page_padding": "px-4 md:px-6",
      "vertical_rhythm": "space-y-6 md:space-y-8",
      "do_not_center_text": "Never apply .App { text-align:center }"
    },
    "player_nav": {
      "pattern": "Bottom navigation bar (thumb reach).",
      "height": "h-[72px]",
      "touch_targets": "min-h-[44px] min-w-[44px]",
      "tabs": ["Home", "Games", "Search", "Chips", "Profile"],
      "tailwind": "fixed bottom-0 left-0 right-0 z-50 border-t border-border/60 bg-[hsl(var(--background)/0.72)] backdrop-blur-xl"
    },
    "admin_layout": {
      "pattern": "Desktop-first 2-column: left rail + content; collapses to top bar + drawer on mobile.",
      "content_width": "max-w-7xl",
      "grid": "grid grid-cols-12 gap-4 md:gap-6",
      "rail": "col-span-12 lg:col-span-3",
      "main": "col-span-12 lg:col-span-9"
    }
  },

  "components": {
    "component_path": {
      "shadcn_ui": "/app/frontend/src/components/ui",
      "primary_components_to_use": [
        "button.jsx",
        "card.jsx",
        "badge.jsx",
        "carousel.jsx",
        "tabs.jsx",
        "dialog.jsx",
        "drawer.jsx",
        "sheet.jsx",
        "input.jsx",
        "input-otp.jsx",
        "form.jsx",
        "select.jsx",
        "switch.jsx",
        "table.jsx",
        "pagination.jsx",
        "scroll-area.jsx",
        "tooltip.jsx",
        "sonner.jsx",
        "calendar.jsx"
      ]
    },
    "design_tokens": {
      "radius": {
        "card": "rounded-2xl",
        "button": "rounded-xl",
        "chip": "rounded-full",
        "modal": "rounded-2xl"
      },
      "shadows": {
        "glass": "shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
        "inner_highlight": "shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]",
        "gold_glow": "shadow-[0_0_0_1px_rgba(255,199,64,0.22),0_10px_30px_rgba(0,0,0,0.35)]"
      },
      "borders": {
        "glass_border": "border border-white/10",
        "gold_border": "border border-[hsl(var(--primary)/0.35)]"
      }
    },

    "player_facing_patterns": {
      "header_balance_bar": {
        "description": "Sticky top header with chip balance + quick actions (Request, History).",
        "use": ["Card", "Button", "Badge", "Tooltip"],
        "tailwind": "sticky top-0 z-40 -mx-4 px-4 md:-mx-6 md:px-6 py-3 bg-[hsl(var(--background)/0.72)] backdrop-blur-xl border-b border-border/60",
        "data_testids": [
          "chip-balance-amount",
          "chip-balance-request-button",
          "chip-balance-history-button"
        ]
      },
      "hero_promo_carousel": {
        "use": ["Carousel", "Card", "Button"],
        "pattern": "One large promo card with subtle aurora backdrop; swipeable; includes CTA to Games.",
        "tailwind": "relative overflow-hidden rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
        "data_testids": ["home-promo-carousel", "home-promo-slide", "home-promo-cta-button"]
      },
      "game_card": {
        "description": "18 distinct CSS key-art cards. Same layout; unique art tokens per game.",
        "use": ["Card", "Badge", "Button", "AspectRatio"],
        "layout": {
          "grid": "grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4",
          "card": "group relative overflow-hidden rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
        },
        "badge": {
          "coming_soon": "absolute top-3 left-3 rounded-full px-2.5 py-1 text-[11px] tracking-wide border bg-[hsl(var(--cyan)/0.14)] border-[hsl(var(--cyan)/0.35)] text-[hsl(var(--cyan))]"
        },
        "hover": "hover:translate-y-[-2px] hover:shadow-[0_16px_40px_rgba(0,0,0,0.45)] transition-[box-shadow,transform] duration-200",
        "data_testids": ["game-card", "game-card-favorite-toggle", "game-card-status-badge"]
      },
      "favorite_toggle": {
        "use": ["Toggle", "Tooltip"],
        "tailwind": "rounded-full bg-black/25 hover:bg-black/35 border border-white/10",
        "data_testids": ["favorite-toggle-button"]
      },
      "chips_wallet": {
        "use": ["Tabs", "Table", "Card", "Input", "Button", "Badge"],
        "pattern": "Tabs: Balance / Request / History. Ledger uses Table with sticky header.",
        "data_testids": [
          "chips-wallet-tabs",
          "chips-request-form",
          "chips-request-submit-button",
          "chips-ledger-table"
        ]
      },
      "announcements_feed": {
        "use": ["Card", "Badge", "ScrollArea"],
        "pattern": "Chronological cards with category badge + timestamp; unread highlight.",
        "data_testids": ["announcements-feed", "announcement-card"]
      },
      "notifications_list": {
        "use": ["Card", "Badge", "Switch"],
        "pattern": "Unread dot + swipe actions optional later; keep tap targets large.",
        "data_testids": ["notifications-list", "notification-item", "notification-unread-badge"]
      }
    },

    "auth_onboarding_patterns": {
      "auth_shell": {
        "pattern": "Centered card within app shell (but text left-aligned).",
        "tailwind": "min-h-dvh flex items-center justify-center px-4 py-10",
        "card": "w-full max-w-[420px] rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
        "data_testids": ["auth-shell", "auth-primary-submit-button"]
      },
      "verify_email": {
        "use": ["InputOTP", "Button"],
        "otp_style": "justify-center gap-2",
        "data_testids": ["verify-email-otp", "verify-email-submit-button", "verify-email-resend-button"]
      },
      "avatar_picker": {
        "use": ["Avatar", "Dialog", "Tabs"],
        "pattern": "Grid of 12–18 preset avatars (SVG/CSS). No external images.",
        "data_testids": ["avatar-picker-open-button", "avatar-picker-option", "avatar-picker-save-button"]
      },
      "pending_approval": {
        "use": ["Card", "Progress", "Badge"],
        "pattern": "Friendly status card with progress shimmer disabled in reduced-motion.",
        "data_testids": ["pending-approval-status"]
      }
    },

    "admin_patterns": {
      "topbar": {
        "use": ["Breadcrumb", "Button", "Avatar", "DropdownMenu"],
        "tailwind": "sticky top-0 z-40 bg-[hsl(var(--background)/0.72)] backdrop-blur-xl border-b border-border/60",
        "data_testids": ["admin-topbar", "admin-user-menu"]
      },
      "tables": {
        "use": ["Table", "DropdownMenu", "Dialog", "Pagination"],
        "pattern": "Approvals tables with row actions; details in Dialog/Sheet.",
        "row_hover": "hover:bg-white/5 transition-[background-color] duration-150",
        "data_testids": [
          "admin-users-table",
          "admin-chip-requests-table",
          "admin-games-table",
          "admin-announcements-table",
          "admin-row-actions-button"
        ]
      },
      "stats_cards": {
        "use": ["Card", "Badge"],
        "pattern": "4-up KPI cards with tiny sparkline placeholder (future recharts).",
        "data_testids": ["admin-kpi-card"]
      },
      "maintenance_toggle": {
        "use": ["Switch", "AlertDialog"],
        "pattern": "Switch requires confirmation dialog.",
        "data_testids": ["admin-maintenance-switch", "admin-maintenance-confirm-button"]
      }
    }
  },

  "game_key_art_system": {
    "goal": "Original 2.5D-feel key art generated from server-provided tokens (gradient from/to, accent, icon, glyph).",
    "card_art_layers": [
      "Base gradient panel (from/to) with subtle vignette",
      "Soft spotlight radial highlight (top-left)",
      "2–3 floating shapes (chips, arcs, stars) using accent color at low opacity",
      "Lucide icon watermark (10–14% opacity)",
      "Large glyph (e.g., '7', 'A♠', '777') in display font with gold edge highlight",
      "Star glints (2–4) using tiny pseudo-elements"
    ],
    "css_scaffold": "/* Example: GameCardArt container */\n.game-art {\n  position: relative;\n  overflow: hidden;\n  border-radius: 1.25rem;\n}\n.game-art::before {\n  content: \"\";\n  position: absolute;\n  inset: 0;\n  background: radial-gradient(600px 220px at 20% 10%, rgba(255,255,255,0.10), transparent 55%);\n  mix-blend-mode: screen;\n}\n.game-art::after {\n  content: \"\";\n  position: absolute;\n  inset: -40%;\n  background: radial-gradient(circle at 50% 50%, rgba(255,199,64,0.10), transparent 55%);\n  transform: rotate(12deg);\n}\n",
    "distinctiveness_rules": [
      "Each of the 18 games must have a unique silhouette language (arcs vs stripes vs concentric rings vs checkerboard vs roulette wedges).",
      "Keep the same typography + badge placement across all cards.",
      "No external images; use CSS gradients, SVG shapes, and lucide icons only.",
      "Ensure COMING_SOON badge is always visible on top of art."
    ]
  },

  "motion_and_microinteractions": {
    "libraries": {
      "framer_motion": {
        "use_cases": [
          "page transitions (fade + slight y)",
          "carousel slide entrance",
          "badge pulse for COMING_SOON (subtle)",
          "bottom nav active indicator"
        ],
        "install": "npm i framer-motion",
        "reduced_motion": "Use useReducedMotion() to disable transforms and looping glints."
      }
    },
    "principles": [
      "60fps: animate opacity/transform only.",
      "No universal transition (never transition: all).",
      "Hover is secondary; prioritize press feedback for touch.",
      "Use subtle star-glint particles only in hero (max 10–14 particles)."
    ],
    "interaction_specs": {
      "buttons": {
        "hover": "hover:brightness-110",
        "press": "active:scale-[0.98]",
        "transition": "transition-[background-color,box-shadow,filter] duration-200"
      },
      "cards": {
        "hover": "hover:translate-y-[-2px]",
        "transition": "transition-[transform,box-shadow] duration-200"
      },
      "coming_soon_badge": {
        "animation": "opacity pulse 2.4s ease-in-out (disabled in reduced motion)",
        "note": "Should feel intentional, not like an error state."
      }
    }
  },

  "accessibility": {
    "requirements": [
      "Minimum 44x44px touch targets.",
      "Visible focus states on all interactive elements.",
      "High contrast toggle: increase text opacity and border contrast.",
      "Reduced motion toggle: disable glints, parallax, looping animations.",
      "Use aria-labels for icon-only buttons.",
      "Use tabular-nums for balances and ledgers."
    ],
    "high_contrast_mode": {
      "approach": "Add a body class (e.g., .hc) that bumps border/text opacities.",
      "css": ".hc .hc-text { color: rgba(255,255,255,0.92); }\n.hc .hc-border { border-color: rgba(255,255,255,0.22); }"
    }
  },

  "testing_attributes": {
    "rule": "All interactive and key informational elements MUST include data-testid (kebab-case, role-based).",
    "examples": [
      "data-testid=\"bottom-nav-home\"",
      "data-testid=\"games-grid\"",
      "data-testid=\"game-detail-play-button\"",
      "data-testid=\"chips-request-amount-input\"",
      "data-testid=\"admin-approve-user-button\""
    ]
  },

  "image_urls": {
    "note": "Image provider tool failed; use CSS/SVG-only art + optional inline SVG noise. No external images required.",
    "categories": [
      {
        "category": "hero_backdrop",
        "description": "CSS-only aurora + star glints behind promo carousel.",
        "urls": []
      },
      {
        "category": "avatars",
        "description": "Preset SVG avatars (12–18) generated locally; no external URLs.",
        "urls": []
      }
    ]
  },

  "instructions_to_main_agent": [
    "Replace default shadcn tokens in /app/frontend/src/index.css with the provided FunGame dark-only palette (keep HSL channels).",
    "Remove CRA starter styles in /app/frontend/src/App.css (logo spin, centered header). Do not center the app container.",
    "Use Manrope for UI and Gloock only for game titles; load via Google Fonts in index.html or CSS import.",
    "Implement a mobile-first app shell with max width and a fixed bottom nav; ensure safe-area padding.",
    "Every screen must show the disclaimer 'PLAY CHIPS — NO CASH VALUE' (header/banner/footer depending on screen).",
    "All games are COMING_SOON: Play buttons disabled but styled as intentional (badge + tooltip).",
    "All interactive and key informational elements must include data-testid attributes (kebab-case).",
    "Use shadcn components from /app/frontend/src/components/ui (no raw HTML dropdown/calendar/toast).",
    "Add Framer Motion for page transitions and subtle glints; respect reduced-motion toggle.",
    "Game cards: generate original CSS key art from server tokens; no external images."
  ],

  "appendix_general_ui_ux_design_guidelines": "<General UI UX Design Guidelines>  \n    - You must **not** apply universal transition. Eg: `transition: all`. This results in breaking transforms. Always add transitions for specific interactive elements like button, input excluding transforms\n    - You must **not** center align the app container, ie do not add `.App { text-align: center; }` in the css file. This disrupts the human natural reading flow of text\n   - NEVER: use AI assistant Emoji characters like`🤖🧠💭💡🔮🎯📚🎭🎬🎪🎉🎊🎁🎀🎂🍰🎈🎨🎰💰💵💳🏦💎🪙💸🤑📊📈📉💹🔢🏆🥇 etc for icons. Always use **FontAwesome cdn** or **lucid-react** library already installed in the package.json\n\n **GRADIENT RESTRICTION RULE**\nNEVER use dark/saturated gradient combos (e.g., purple/pink) on any UI element.  Prohibited gradients: blue-500 to purple 600, purple 500 to pink-500, green-500 to blue-500, red to pink etc\nNEVER use dark gradients for logo, testimonial, footer etc\nNEVER let gradients cover more than 20% of the viewport.\nNEVER apply gradients to text-heavy content or reading areas.\nNEVER use gradients on small UI elements (<100px width).\nNEVER stack multiple gradient layers in the same viewport.\n\n**ENFORCEMENT RULE:**\n    • Id gradient area exceeds 20% of viewport OR affects readability, **THEN** use solid colors\n\n**How and where to use:**\n   • Section backgrounds (not content backgrounds)\n   • Hero section header content. Eg: dark to light to dark color\n   • Decorative overlays and accent elements only\n   • Hero section with 2-3 mild color\n   • Gradients creation can be done for any angle say horizontal, vertical or diagonal\n\n- For AI chat, voice application, **do not use purple color. Use color like light green, ocean blue, peach orange etc**\n\n</Font Guidelines>\n\n- Every interaction needs micro-animations - hover states, transitions, parallax effects, and entrance animations. Static = dead. \n   \n- Use 2-3x more spacing than feels comfortable. Cramped designs look cheap.\n\n- Subtle grain textures, noise overlays, custom cursors, selection states, and loading animations: separates good from extraordinary.\n   \n- Before generating UI, infer the visual style from the problem statement (palette, contrast, mood, motion) and immediately instantiate it by setting global design tokens (primary, secondary/accent, background, foreground, ring, state colors), rather than relying on any library defaults. Don't make the background dark as a default step, always understand problem first and define colors accordingly\n    Eg: - if it implies playful/energetic, choose a colorful scheme\n           - if it implies monochrome/minimal, choose a black–white/neutral scheme\n\n**Component Reuse:**\n\t- Prioritize using pre-existing components from src/components/ui when applicable\n\t- Create new components that match the style and conventions of existing components when needed\n\t- Examine existing components to understand the project's component patterns before creating new ones\n\n**IMPORTANT**: Do not use HTML based component like dropdown, calendar, toast etc. You **MUST** always use `/app/frontend/src/components/ui/ ` only as a primary components as these are modern and stylish component\n\n**Best Practices:**\n\t- Use Shadcn/UI as the primary component library for consistency and accessibility\n\t- Import path: ./components/[component-name]\n\n**Export Conventions:**\n\t- Components MUST use named exports (export const ComponentName = ...)\n\t- Pages MUST use default exports (export default function PageName() {...})\n\n**Toasts:**\n  - Use `sonner` for toasts\"\n  - Sonner component are located in `/app/src/components/ui/sonner.tsx`\n\nUse 2–4 color gradients, subtle textures/noise overlays, or CSS-based noise to avoid flat visuals.\n</General UI UX Design Guidelines>"
}
