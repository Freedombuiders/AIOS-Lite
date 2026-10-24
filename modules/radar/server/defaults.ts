/** Default Radar configuration: the three layers, their sources, topic taxonomies and keyword lists. */

import type { LayerConfig, RadarConfig, TopicDef } from './types.js';

const VN_TOPICS: TopicDef[] = [
  { key: 'goi-token', label: 'Gói, hạn mức, token', keywords: ['gói', 'goi', 'hạn mức', 'limit', 'token', 'quota', 'pro max', 'max plan', 'plus', 'pro', 'hết lượt', 'giới hạn', 'rate limit', 'credit'] },
  { key: 'tai-khoan', label: 'Tài khoản, tiền, bán lại', keywords: ['tài khoản', 'tai khoan', 'acc', 'mua chung', 'dùng chung', 'share chung', 'bán lại', 'giá rẻ', 'slot', 'reseller', 'key', 'api key', 'thanh toán', 'thẻ visa', 'bị khóa', 'bị ban'] },
  { key: 'chon-cong-cu', label: 'Chọn công cụ theo nghề', keywords: ['nên dùng', 'chọn', 'so sánh', 'khác gì', 'hay hơn', 'tốt hơn', 'công cụ nào', 'ai nào', 'claude hay chatgpt', 'gemini hay', 'review'] },
  { key: 'lead-magnet', label: 'Lead magnet, tài liệu, prompt free', keywords: ['tài liệu', 'prompt', 'free', 'miễn phí', 'cho xin', 'xin file', 'comment nhận', 'tặng', 'ebook', 'checklist', 'template', 'mẫu', 'bộ prompt'] },
  { key: 'hoc-prompt', label: 'Học prompt, workshop, khóa học', keywords: ['học', 'khóa học', 'khoa hoc', 'workshop', 'lớp học', 'đào tạo', 'hướng dẫn', 'tutorial', 'master', 'zoom', 'webinar', 'học viên', 'từ đầu', 'người mới'] },
  { key: 'tu-lam-app', label: 'Tự làm app, agent, automation', keywords: ['agent', 'automation', 'tự động hóa', 'tu dong hoa', 'n8n', 'workflow', 'app', 'code', 'lập trình', 'vibe coding', 'mcp', 'bot', 'skill', 'claude code', 'codex', 'antigravity', 'cursor'] },
  { key: 'video-ai', label: 'Video AI', keywords: ['video', 'veo', 'sora', 'kling', 'runway', 'capcut', 'hình ảnh', 'ảnh ai', 'midjourney', 'giọng đọc', 'clip', 'reels', 'tiktok'] },
  { key: 'ai-giao-duc', label: 'AI cho giáo dục', keywords: ['giáo viên', 'giáo dục', 'học sinh', 'sinh viên', 'bài giảng', 'giáo án', 'trường', 'lớp', 'thầy cô', 'con học', 'phụ huynh', 'đề thi'] },
  { key: 'tin-model-moi', label: 'Tin, model mới, cập nhật', keywords: ['ra mắt', 'model mới', 'cập nhật', 'update', 'phiên bản', 'opus', 'sonnet', 'gpt-5', 'gpt 5', 'gemini 3', 'claude 5', 'thông báo', 'vừa ra', 'release'] },
];

const NGANH_TOPICS: TopicDef[] = [
  { key: 'soan-bai', label: 'Soạn bài, giấy tờ, báo cáo', keywords: ['soạn bài', 'giáo án', 'báo cáo', 'công văn', 'văn bản', 'giấy tờ', 'biên bản', 'soạn thảo', 'viết bài', 'bài giảng', 'slide', 'powerpoint', 'đề thi', 'tờ trình'] },
  { key: 'so-thay-the', label: 'Sợ bị thay thế, lo lắng', keywords: ['thay thế', 'mất việc', 'thất nghiệp', 'sợ', 'lo lắng', 'lo ngại', 'đe dọa', 'cướp việc', 'sa thải', 'tương lai nghề', 'đào thải'] },
  { key: 'chon-cong-cu', label: 'Chọn công cụ nào', keywords: ['nên dùng', 'công cụ nào', 'chọn', 'so sánh', 'khác gì', 'hay hơn', 'tốt hơn', 'chatgpt hay', 'gemini hay', 'claude hay', 'copilot', 'app nào'] },
  { key: 'hoc-tu-dau', label: 'Học từ đâu, khóa học', keywords: ['học', 'khóa học', 'khoa hoc', 'lớp học', 'đào tạo', 'hướng dẫn', 'từ đâu', 'người mới', 'bắt đầu', 'masterclass', 'tập huấn', 'bồi dưỡng', 'năng lực số'] },
  { key: 'gian-lan', label: 'Gian lận, đạo đức, con dùng AI', keywords: ['gian lận', 'chép bài', 'đạo văn', 'đạo đức', 'làm hộ', 'làm bài hộ', 'con dùng', 'cấm', 'phát hiện ai', 'ai viết', 'lệ thuộc', 'phụ thuộc', 'bịa', 'ảo giác'] },
  { key: 'so-lieu', label: 'Số liệu, Excel, kế toán', keywords: ['excel', 'kế toán', 'ke toan', 'số liệu', 'hóa đơn', 'thuế', 'báo cáo tài chính', 'sổ sách', 'google sheet', 'bảng tính', 'tndn', 'gtgt', 'công thức'] },
  { key: 'ban-hang', label: 'Bán hàng, nội dung, quảng cáo', keywords: ['bán hàng', 'content', 'nội dung', 'quảng cáo', 'seo', 'marketing', 'chạy ads', 'facebook ads', 'affiliate', 'chốt đơn', 'khách hàng', 'viết bài', 'kịch bản', 'thương hiệu'] },
  { key: 'chi-phi', label: 'Chi phí, mua tài khoản', keywords: ['giá', 'chi phí', 'mua', 'tài khoản', 'tai khoan', 'dùng chung', 'mua chung', 'gói', 'plus', 'pro', 'vat', 'đắt', 'rẻ', 'tháng', 'trả phí', 'miễn phí'] },
];

const WORLD_TOPICS: TopicDef[] = [
  { key: 'agent', label: 'Agent và tự động hoá', keywords: ['agent', 'agents', 'agentic', 'automation', 'workflow', 'mcp', 'autonomous', 'orchestrat', 'multi-agent', 'tool use', 'computer use', 'claude code', 'codex', 'openclaw'] },
  { key: 'model-gia-re', label: 'Model mới, giá rẻ', keywords: ['model', 'release', 'launch', 'opus', 'sonnet', 'haiku', 'gpt', 'gemini', 'llama', 'qwen', 'deepseek', 'kimi', 'mistral', 'pricing', 'price', 'cheaper', 'free tier', 'open source', 'open-source', 'open weights'] },
  { key: 'lap-trinh', label: 'Công cụ lập trình AI', keywords: ['coding', 'cursor', 'copilot', 'windsurf', 'antigravity', 'ide', 'vibe coding', 'pull request', 'code review', 'developer', 'cli', 'github', 'repo', 'sdk', 'api'] },
  { key: 'video-anh-giong', label: 'Video, hình ảnh, giọng nói AI', keywords: ['video', 'image', 'veo', 'sora', 'kling', 'runway', 'midjourney', 'flux', 'voice', 'tts', 'speech', 'music', 'suno', 'elevenlabs', 'diffusion', 'avatar', 'heygen'] },
  { key: 'phan-cung-local', label: 'Phần cứng, chạy local', keywords: ['local', 'locally', 'gpu', 'rtx', 'vram', 'nvidia', 'apple silicon', 'mlx', 'ollama', 'llama.cpp', 'gguf', 'quantiz', 'on-device', 'laptop', 'raspberry', 'chip', 'inference'] },
  { key: 'san-pham-pho-thong', label: 'Sản phẩm AI cho người dùng phổ thông', keywords: ['app', 'consumer', 'chatgpt', 'assistant', 'browser', 'search', 'notebooklm', 'perplexity', 'mobile', 'iphone', 'android', 'subscription', 'plus', 'users', 'million users', 'launches'] },
  { key: 'nghien-cuu', label: 'Nghiên cứu, benchmark', keywords: ['benchmark', 'paper', 'research', 'arxiv', 'eval', 'swe-bench', 'leaderboard', 'reasoning', 'scaling', 'dataset', 'study', 'sota', 'training', 'alignment'] },
  { key: 'chinh-sach', label: 'Chính sách, an toàn', keywords: ['policy', 'regulation', 'safety', 'law', 'lawsuit', 'copyright', 'ban', 'eu ai act', 'government', 'security', 'jailbreak', 'privacy', 'risk', 'ethics', 'congress'] },
];

const AI_KEYWORDS = [
  'AI', 'ChatGPT', 'Chat GPT', 'GPT', 'Gemini', 'Claude', 'Copilot', 'Grok', 'DeepSeek', 'NotebookLM', 'Midjourney',
  'trí tuệ nhân tạo', 'prompt', 'Codex', 'Antigravity', 'LLM', 'OpenAI', 'Anthropic',
];

const BUY_KEYWORDS = {
  intent: [
    'mua', 'cần mua', 'chỉ mình chỗ mua', 'chỉ chỗ mua', 'ai có', 'share chung', 'dùng chung', 'mua chung', 'inbox', 'ib',
    'đăng ký', 'cho xin link', 'xin link', 'đăng kí', 'còn slot', 'ghép nhóm', 'tìm người share', 'order',
  ],
  price: [
    'giá', 'bao nhiêu', 'phí', 'nhiêu tiền', 'bao nhiêu tiền', 'đắt', 'rẻ', 'báo giá', 'giá sao', 'giá thế nào', 'học phí', 'chi phí',
  ],
  material: [
    'xin tài liệu', 'cho mình xin', 'cho em xin', 'xin file', 'xin prompt', 'comment nhận', 'loop', 'xin ebook', 'xin mẫu',
    'gửi mình với', 'gửi em với', 'xin link tài liệu', 'cho xin',
  ],
};

function emptyLayer(): Omit<LayerConfig, 'key' | 'label' | 'time' | 'description' | 'topics' | 'professions'> {
  return {
    enabled: true,
    fbGroups: [],
    fbPages: [],
    instagram: [],
    adLibrary: { enabled: false, country: 'VN', queries: [], pageUrls: [] },
    x: { enabled: false, accounts: [], queries: [], vnCheck: false },
    reddit: { enabled: false, subreddits: [] },
    hackerNews: { enabled: false, minPoints: 100 },
    youtube: { enabled: false, channels: [] },
    tiktok: { enabled: false, queries: [], accounts: [] },
    threads: { enabled: false, queries: [], accounts: [] },
    github: { enabled: false, queries: [] },
    news: { enabled: false, rss: [] },
    aiOnly: false,
    windowHours: 24,
    firstWindowHours: 168,
    maxPerSource: 30,
    commentPosts: 12,
  };
}

export function defaultRadarConfig(): RadarConfig {
  const vn: LayerConfig = {
    ...emptyLayer(),
    key: 'vn',
    label: 'AI trong nước',
    time: '07:00',
    description: 'Các nhóm Facebook về AI, fanpage đối thủ, quảng cáo trên Meta Ad Library: người Việt đang hỏi gì, ai đang bán gì, giá bao nhiêu.',
    fbGroups: [
      { name: 'Cơm AI lo', url: 'https://www.facebook.com/groups/comailo', members: 205000 },
      { name: 'Cộng đồng Claude AI Việt Nam', url: 'https://www.facebook.com/groups/sacmaucuocsongxaque', members: 413000 },
      { name: 'Claude VN', url: 'https://www.facebook.com/groups/2403721346759140', members: 728000 },
      { name: 'Codex VN', url: 'https://www.facebook.com/groups/1528487012172019', members: 303000 },
      { name: 'Antigravity VN', url: 'https://www.facebook.com/groups/945603251671521', members: 222000 },
      { name: 'Nghiện AI (Học và Làm AI)', url: 'https://www.facebook.com/groups/congdongaitaivietnam', members: 380000 },
      { name: 'Bình Dân Học AI', url: 'https://www.facebook.com/groups/binhdanhocai', members: 664000 },
    ],
    fbPages: [
      { name: 'Ứng Dụng AI Mỗi Ngày', url: 'https://www.facebook.com/ungdungaimoingay' },
      { name: 'Ứng Dụng AI Siêu Thực', url: 'https://www.facebook.com/hocvienaimarketing' },
      { name: 'AI Workforce (Alobase)', url: 'https://www.facebook.com/aiworkforce.alobase.vn' },
      { name: 'Bình dân Học AI (page)', url: 'https://www.facebook.com/binhdanhocai.vn' },
    ],
    adLibrary: { enabled: true, country: 'VN', queries: ['khóa học AI', 'Claude AI', 'ChatGPT', 'học AI', 'AI agent', 'n8n'], pageUrls: [] },
    topics: VN_TOPICS,
    professions: [],
  };

  const world: LayerConfig = {
    ...emptyLayer(),
    key: 'world',
    label: 'Thế giới',
    time: '12:00',
    description: 'X, Reddit, Hacker News, YouTube, GitHub, TikTok, Threads: chỉ giữ những chủ đề AI đang lớn ở nước ngoài mà Việt Nam chưa bàn nhiều.',
    x: {
      enabled: true,
      accounts: ['bcherny', 'claudeai', 'AnthropicAI', 'OpenAI', 'OpenAIDevs', 'GoogleAI', 'antigravity', 'NousResearch', 'Teknium', 'openclaw', 'testingcatalog', 'karpathy', 'steipete'],
      queries: ['Claude Code', 'Codex', 'AI agent', 'Gemini'],
      vnCheck: true,
    },
    fbPages: [
      { name: 'OpenAI', url: 'https://www.facebook.com/openai' },
      { name: 'Meta AI', url: 'https://www.facebook.com/AIatMeta' },
    ],
    reddit: { enabled: true, subreddits: ['LocalLLaMA', 'ClaudeAI', 'ChatGPT', 'singularity', 'OpenAI'] },
    hackerNews: { enabled: true, minPoints: 100 },
    youtube: {
      enabled: true,
      channels: [
        { name: 'Nate Herk', channelId: 'UC2ojq-nuP8ceeHqiroeKhBA' },
        { name: 'Matthew Berman', channelId: 'UCawZsQWqfGSbCI5yjkdVkTA' },
        { name: 'Cole Medin', channelId: 'UCMwVTLZIRRUyyVrkjDpn4pA' },
        { name: 'OpenAI', channelId: '@OpenAI' },
        { name: 'Anthropic', channelId: '@anthropic-ai' },
      ],
    },
    tiktok: { enabled: true, queries: ['AI agent', 'Claude AI'], accounts: ['openai'] },
    threads: { enabled: true, queries: ['Claude AI', 'AI agent', 'Claude Code'], accounts: ['openai', 'zuck'] },
    github: { enabled: true, queries: ['AI agent', 'LLM', 'MCP server', 'Claude Code'] },
    topics: WORLD_TOPICS,
    professions: [],
  };

  const nganh: LayerConfig = {
    ...emptyLayer(),
    key: 'nganh',
    label: 'Ngành nghề',
    time: '20:00',
    description: 'Cộng đồng nghề không chuyên AI (giáo viên, phụ huynh, kế toán, marketing, nhân sự…): chỉ những bài và bình luận nói về AI, nỗi đau và nỗi sợ của từng nghề.',
    fbGroups: [
      { name: 'Phụ huynh TP.HCM', url: 'https://www.facebook.com/groups/PhuHuynhTPHCM', members: 434000, profession: 'Phụ huynh' },
      { name: 'Giáo Viên Tiếng Anh', url: 'https://www.facebook.com/groups/1947317768815047', members: 151000, profession: 'Giáo viên' },
      { name: 'Phụ huynh Hà Nội', url: 'https://www.facebook.com/groups/hoiphuhuynhhanoichinhthuc', members: 345000, profession: 'Phụ huynh' },
      { name: 'HrShare', url: 'https://www.facebook.com/groups/hrlinkvn', members: 323000, profession: 'Nhân sự' },
      { name: 'Cùng Con Học Tiểu Học', url: 'https://www.facebook.com/groups/1134108577560995', members: 195000, profession: 'Phụ huynh' },
      { name: 'Kế Toán Việt Nam', url: 'https://www.facebook.com/groups/hoiketoanvn', members: 634000, profession: 'Kế toán' },
      { name: 'Agency Việt Nam', url: 'https://www.facebook.com/groups/2448917765429233', members: 73000, profession: 'Marketing' },
      { name: 'Tomorrow Marketers', url: 'https://www.facebook.com/groups/tomorrowmarketers.businesscase', members: 134000, profession: 'Marketing' },
      { name: 'SEO Marketing', url: 'https://www.facebook.com/groups/seovamarketing', members: 141000, profession: 'Marketing' },
      { name: 'Nhóm Bán Hàng Online', url: 'https://www.facebook.com/groups/1750186668328113', members: 463000, profession: 'Bán hàng online' },
    ],
    tiktok: { enabled: true, queries: ['AI giáo viên', 'ChatGPT kế toán', 'AI văn phòng'], accounts: [] },
    threads: { enabled: true, queries: ['ChatGPT giáo viên', 'AI kế toán'], accounts: [] },
    news: {
      enabled: true,
      rss: [
        'https://vnexpress.net/rss/so-hoa.rss',
        'https://dantri.com.vn/rss/cong-nghe.rss',
        'https://tuoitre.vn/rss/nhip-song-so.rss',
      ],
    },
    professions: ['Giáo viên', 'Phụ huynh', 'Công chức, viên chức', 'Kế toán', 'Marketing', 'Bán hàng online', 'Nhân sự', 'Dân văn phòng', 'Học sinh, sinh viên'],
    aiOnly: true,
    topics: NGANH_TOPICS,
  };

  return {
    version: 1,
    enabled: false,
    timezone: 'Asia/Ho_Chi_Minh',
    owner: { name: '', channels: ['Mọi kênh'], about: '' },
    analysisAgentId: 'radar-analyst',
    aiKeywords: AI_KEYWORDS,
    buyKeywords: BUY_KEYWORDS,
    layers: { vn, world, nganh },
  };
}
