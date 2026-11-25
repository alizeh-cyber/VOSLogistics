// Shared settings for the VOS portal pages (public values only; safe to publish).
window.VOS = {
  SUPABASE_URL: "https://xzlnzldolzqlhbqfgjeh.supabase.co",
  SUPABASE_KEY: "sb_publishable_NqaGDUXVR33CekpHZyntFg_f-i5FDGy",
  JOB_URL: "https://alizeh-cyber.github.io/VOSLogistics/",
  SWAPS_ADVANCED: 40,
  SWAPS_BEGINNER: 25
};
window.vosClient = function () {
  return window.supabase.createClient(VOS.SUPABASE_URL, VOS.SUPABASE_KEY);
};
window.esc = function (s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
};
