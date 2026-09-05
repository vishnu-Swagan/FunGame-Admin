# Promotion reward-vault asset

## Result

- Model: Higgsfield GPT Image 2
- Output: 3:4, 2K, high quality
- Generated source: <https://d8j0ntlcm91z4.cloudfront.net/user_3GzF4pYx0vSvTCLgYCgMDPWBBVK/hf_20260902_010657_fa378458-41a0-4577-9843-9502334d5c1d.png>
- Application asset: `frontend/public/promo/reward-vault.webp`
- Final dimensions: 1744×2336
- Final size: approximately 319 KB
- Suggested alt text: “Gold reward vault with an emerald center.”

The two LottoWin screenshots were used only as high-level visual references. They were never supplied to Higgsfield as source or reference images. The generated asset is an original gold-ring and emerald-vault concept with no copied logo, game art, chest design, text, people, currency symbol, or trademark.

## Exact generation workflow

```sh
higgsfield account status
higgsfield model list --json
higgsfield model get gpt_image_2 --json
higgsfield generate create gpt_image_2 \
  --prompt "Original premium 3D reward vault formed from concentric gold rings and a faceted emerald core, dark midnight casino atmosphere, brushed metal, controlled rim light, elegant mobile game artwork, isolated central subject, generous negative space, crisp silhouette, no people, no text, no logos, no currency symbols, no trademarks, no copied chest design." \
  --aspect_ratio 3:4 \
  --resolution 2k \
  --quality high \
  --wait \
  --wait-timeout 20m
```

The generated PNG was downloaded, visually inspected, and converted to WebP at quality 84. The final WebP was inspected again at original resolution before integration.

## Reproduction note

Higgsfield generation is nondeterministic, so rerunning the command creates a new original interpretation. Keep the checked-in WebP for a stable production asset and use the command only when a deliberately new art direction is required.
