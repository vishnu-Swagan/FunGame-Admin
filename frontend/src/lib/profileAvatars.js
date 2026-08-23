export const CARTOON_AVATAR_COUNT = 60;
export const CARTOON_AVATAR_KEY_PREFIX = "avatar-";

const padAvatarNumber = (value) => String(value).padStart(2, "0");

export const CARTOON_AVATARS = Object.freeze(
  Array.from({ length: CARTOON_AVATAR_COUNT }, (_, index) => {
    const number = padAvatarNumber(index + 1);
    return Object.freeze({
      key: `${CARTOON_AVATAR_KEY_PREFIX}${number}`,
      label: `Royal Avatar ${number}`,
      number,
      src: `/game-art/avatars/cartoon/avatar-${number}.png`,
      searchText: `royal avatar ${number} 3d cartoon portrait`,
    });
  }),
);

export function cartoonAvatarForKey(value) {
  const key = String(value || "").trim().toLowerCase();
  const match = /^avatar-(\d{2})$/.exec(key);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > CARTOON_AVATAR_COUNT) return null;
  return CARTOON_AVATARS[number - 1];
}

export function filterCartoonAvatars(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return CARTOON_AVATARS;
  if (/^\d{1,2}$/.test(normalized)) {
    const exactNumber = Number(normalized);
    if (exactNumber >= 1 && exactNumber <= CARTOON_AVATAR_COUNT) {
      return [CARTOON_AVATARS[exactNumber - 1]];
    }
  }
  return CARTOON_AVATARS.filter((avatar) => avatar.searchText.includes(normalized));
}
