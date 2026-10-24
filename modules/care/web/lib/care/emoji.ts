// Emoji of the reply box picker: a small self-contained set (no dependency), grouped by category. The category label comes
// from `care.inbox2.emoji.cat.<id>`. Pure data.

export interface EmojiCategory {
  id: 'smile' | 'gesture' | 'heart' | 'object' | 'nature' | 'food' | 'travel' | 'symbol';
  /** Shown on the category tab. */
  icon: string;
  items: string[];
}

// Space-separated so that every entry survives the fallback split.
const raw: Array<[EmojiCategory['id'], string, string]> = [
  ['smile', '😀', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 🙂 🙃 😉 😍 🥰 😘 😗 😋 😛 😜 🤪 🤗 🤭 🤔 🤨 😐 😑 😶 🙄 😏 😌 😴 🤤 😷 🤒 🤕 🥵 🥶 😎 🤓 🧐 😕 😟 🙁 😮 😲 😳 🥺 😢 😭 😱 😖 😞 😓 😩 😫 😤 😡 😠 🤬 😇 🥳 🤩'],
  ['gesture', '👍', '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 🤲 💪 ✍️ 🤳 💅'],
  ['heart', '❤️', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 😻 💋 💯 💢 💥 💫 ✨ 🔥 🌟 ⭐'],
  ['object', '🎁', '🎁 🎉 🎊 🎈 📦 🛒 🛍️ 💰 💵 💳 🧾 📞 📱 💻 📷 🎥 📅 📌 📍 📎 ✏️ 📝 📢 🔔 ⏰ ⌛ 🔑 🔒 💡 🏷️ 🚚 ✈️ 🏠 🏢'],
  ['nature', '🌸', '🌸 🌹 🌺 🌻 🌼 🌷 🌱 🌿 🍀 🍃 🌳 🌴 🌵 🌈 ☀️ ⛅ ☁️ 🌧️ ⚡ ❄️ 🌙 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦋 🐝'],
  ['food', '🍜', '🍜 🍲 🍚 🍙 🍱 🍣 🍕 🍔 🍟 🌭 🥪 🌮 🍝 🥗 🍳 🥞 🍞 🥐 🍰 🎂 🍩 🍪 🍫 🍦 🍎 🍌 🍉 🍇 🍓 🍊 🥭 🥑 🍅 🥕 ☕ 🍵 🍺 🍷 🥤'],
  ['travel', '🚗', '🚗 🚕 🚌 🚑 🚒 🚚 🏍️ 🚲 ✈️ 🚀 🚢 🏖️ 🏝️ ⛰️ 🏨 🏥 🏫 🏪 🗺️ 🧳'],
  ['symbol', '✅', '✅ ❌ ❎ ⭕ ❗ ❓ ⚠️ 🚫 ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ✔️ ➰ 🆗 🆕 🆓 🔝 ©️ ®️ ™️'],
];

export const EMOJI_CATEGORIES: EmojiCategory[] = raw.map(([id, icon, list]) => ({ id, icon, items: list.split(/\s+/).filter(Boolean) }));
