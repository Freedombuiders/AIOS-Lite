/**
 * Pancake commands for `integration-cli pancake <command>`.
 *
 * Output is read by an LLM: compact JSON by default (only useful keys, money as
 * numbers, status as {code, name}, ids as strings), the raw API object with
 * `--full`. Error messages say what to do next. Descriptions are English for the
 * agent; the usage errors the owner may see are Vietnamese like the rest of the
 * integration framework.
 */
import {
  IntegrationUsageError,
  type IntegrationCommand,
  type IntegrationCommandContext,
  type IntegrationValues,
  type ParsedArgs,
} from '../types.js';
import {
  ORDER_STATUSES,
  createPancakePagesClient,
  createPancakePosClient,
  orderStatusName,
  parseOrderStatus,
  parsePageTokens,
  parseTimeArg,
  unwrapEntity,
  type FetchImpl,
  type PancakePagesClient,
  type PancakePosClient,
} from './client.js';

export interface PancakeCommandDeps {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_CHAT_RANGE_SECONDS = 31 * 86_400;

type Obj = Record<string, any>;

// ── Argument helpers ────────────────────────────────────────────────────

function assertFlags(args: ParsedArgs, allowed: string[]): void {
  const bad = Object.keys(args.flags).filter((f) => !allowed.includes(f));
  if (bad.length === 0) return;
  const list = allowed.length ? allowed.map((f) => `--${f}`).join(', ') : 'none';
  throw new IntegrationUsageError(
    `Flag không hỗ trợ: ${bad.map((f) => `--${f}`).join(', ')}. Flag hợp lệ cho lệnh này: ${list}.`,
  );
}

function strFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true || !String(v).trim()) throw new IntegrationUsageError(`--${name} cần một giá trị: --${name} <value>.`);
  return String(v).trim();
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  if (v === undefined) return false;
  if (v === true) return true;
  return !['false', '0', 'no'].includes(String(v).toLowerCase());
}

function intFlag(
  args: ParsedArgs, name: string, opts: { min?: number; max?: number } = {},
): number | undefined {
  const raw = strFlag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new IntegrationUsageError(`--${name} phải là số nguyên, nhận được "${raw}".`);
  if (opts.min !== undefined && n < opts.min) throw new IntegrationUsageError(`--${name} phải >= ${opts.min}.`);
  return opts.max !== undefined ? Math.min(n, opts.max) : n;
}

function limitFlag(args: ParsedArgs): number {
  return intFlag(args, 'limit', { min: 1, max: MAX_LIMIT }) ?? DEFAULT_LIMIT;
}

function requirePositional(args: ParsedArgs, index: number, what: string, example: string): string {
  const v = args.positionals[index];
  if (!v) throw new IntegrationUsageError(`Thiếu ${what}. Ví dụ: ${example}`);
  return v;
}

function statusList(): string {
  return ORDER_STATUSES.map((s) => `${s.code}=${s.name}`).join(', ');
}

function statusFromArg(raw: string): number {
  const code = parseOrderStatus(raw);
  if (code === null) {
    throw new IntegrationUsageError(`Trạng thái "${raw}" không hợp lệ. Dùng mã hoặc tên, một trong: ${statusList()}.`);
  }
  return code;
}

// ── Compact mappers ─────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function iso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return new Date(v > 1e11 ? v : v * 1000).toISOString();
  return String(v);
}

/** Drops undefined / null / empty-string / empty-array so the agent reads only what is there. */
function clean<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete o[k];
  }
  return o;
}

function addressText(a: unknown): string | undefined {
  if (!a || typeof a !== 'object') return typeof a === 'string' && a ? a : undefined;
  const o = a as Obj;
  if (o.full_address) return String(o.full_address);
  const parts = [o.address, o.commune_name, o.district_name, o.province_name]
    .filter((p) => typeof p === 'string' && p);
  return parts.length ? parts.join(', ') : undefined;
}

function compactOrder(o: Obj): Obj {
  const code = num(o.status);
  const ship = (o.shipping_address && typeof o.shipping_address === 'object' ? o.shipping_address : {}) as Obj;
  return clean({
    id: o.id !== undefined ? String(o.id) : undefined,
    displayId: o.display_id !== undefined ? String(o.display_id) : undefined,
    customOrderId: o.custom_id || undefined,
    status: code !== undefined
      ? { code, name: orderStatusName(code) !== 'Unknown' ? orderStatusName(code) : (o.status_name ?? 'Unknown') }
      : undefined,
    createdAt: iso(o.inserted_at),
    updatedAt: iso(o.updated_at),
    customer: clean({
      id: o.customer?.id ?? undefined,
      name: o.bill_full_name || ship.full_name || undefined,
      phone: o.bill_phone_number || ship.phone_number || undefined,
    }),
    shipTo: clean({ name: ship.full_name, phone: ship.phone_number, address: addressText(ship) }),
    items: Array.isArray(o.items)
      ? o.items.map((i: Obj) => clean({
        sku: i.variation_info?.display_id ?? undefined,
        variationId: i.variation_id ?? undefined,
        name: i.variation_info?.name ?? undefined,
        qty: num(i.quantity),
        price: num(i.variation_info?.retail_price),
      }))
      : undefined,
    total: num(o.total_price),
    discount: num(o.total_discount),
    shippingFee: num(o.shipping_fee),
    cod: num(o.cod),
    moneyToCollect: num(o.money_to_collect),
    carrierStatus: o.partner?.partner_status || undefined,
    trackingCode: o.partner?.extend_code || undefined,
    note: o.note || undefined,
    tags: Array.isArray(o.tags) ? o.tags.map((t: Obj) => t?.name ?? t).filter(Boolean) : undefined,
    warehouseId: o.warehouse_id || undefined,
    conversationId: o.conversation_id || undefined,
    pageId: o.page_id || undefined,
  });
}

function compactCustomer(c: Obj): Obj {
  return clean({
    id: c.id !== undefined ? String(c.id) : undefined,
    name: c.name,
    phones: c.phone_numbers,
    emails: c.emails,
    birthday: c.date_of_birth || undefined,
    orders: num(c.order_count),
    succeededOrders: num(c.succeed_order_count),
    totalSpent: num(c.purchased_amount),
    points: num(c.reward_point),
    lastOrderAt: iso(c.last_order_at),
    tags: Array.isArray(c.tags) ? c.tags.map((t: Obj) => t?.name ?? t).filter(Boolean) : undefined,
    address: addressText(Array.isArray(c.shop_customer_address) ? c.shop_customer_address[0] : c.shop_customer_address),
    notes: Array.isArray(c.notes) ? c.notes.map((n: Obj) => n?.message ?? n).filter(Boolean) : c.notes || undefined,
    chatLink: c.conversation_link || undefined,
  });
}

function compactVariation(v: Obj): Obj {
  const variant = Array.isArray(v.fields)
    ? v.fields.map((f: Obj) => (f?.name && f?.value ? `${f.name}: ${f.value}` : '')).filter(Boolean).join(', ')
    : undefined;
  return clean({
    id: v.id !== undefined ? String(v.id) : undefined,
    sku: v.display_id !== undefined ? String(v.display_id) : undefined,
    barcode: v.barcode || undefined,
    name: v.product?.name ?? v.name,
    variant: variant || undefined,
    price: num(v.retail_price),
    stock: num(v.remain_quantity),
    warehouses: Array.isArray(v.variations_warehouses)
      ? v.variations_warehouses.map((w: Obj) => clean({
        warehouseId: w.warehouse_id,
        stock: num(w.remain_quantity),
        available: num(w.available_quantity),
        onHand: num(w.actual_remain_quantity),
      }))
      : undefined,
  });
}

function listResult(raw: Obj, items: unknown[], limit: number, requestedPage: number | undefined): Obj {
  const size = num(raw.page_size);
  return clean({
    total: num(raw.total_entries) ?? items.length,
    page: num(raw.page_number) ?? requestedPage ?? 1,
    pageSize: size ?? limit,
    totalPages: num(raw.total_pages),
    items: items.slice(0, limit),
  });
}

function dataArray(raw: Obj): Obj[] {
  return Array.isArray(raw.data) ? raw.data : [];
}

// ── Command factory ─────────────────────────────────────────────────────

export function buildPancakeCommands(deps: PancakeCommandDeps = {}): IntegrationCommand[] {
  const http = { fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl };

  function posKey(values: IntegrationValues): string {
    const key = values.pos_api_key?.trim();
    if (!key) {
      throw new IntegrationUsageError(
        'Chưa nhập API key Pancake POS. Chủ cần nhập ở trang Integrations; lệnh chat (pages, conversations, messages, tags, reply, tag) vẫn dùng được nếu đã nhập page access token.',
      );
    }
    return key;
  }

  function posClient(ctx: IntegrationCommandContext, shopId?: string): PancakePosClient {
    return createPancakePosClient({
      apiKey: posKey(ctx.values),
      shopId: shopId || ctx.values.shop_id?.trim() || undefined,
      signal: ctx.signal,
      ...http,
    });
  }

  /** Client with a shop id resolved: --shop, else the stored one, else the account's first shop. */
  async function posClientWithShop(ctx: IntegrationCommandContext, args: ParsedArgs): Promise<PancakePosClient> {
    const explicit = strFlag(args, 'shop');
    let client = posClient(ctx, explicit);
    if (client.shopId) return client;
    const shops = await client.listShops();
    const pick = shops.find((s) => s.preferred_shop) ?? shops[0];
    if (!pick) throw new IntegrationUsageError('API key này không truy cập được shop nào trên Pancake POS.');
    client = posClient(ctx, String(pick.id));
    return client;
  }

  function pageClient(ctx: IntegrationCommandContext, args: ParsedArgs): { client: PancakePagesClient; pageId: string } {
    const pages = parsePageTokens(ctx.values.page_tokens);
    if (pages.length === 0) {
      throw new IntegrationUsageError(
        'Chưa nhập page access token Pancake. Chủ cần nhập ở trang Integrations (định dạng page_id:token).',
      );
    }
    const ids = pages.map((p) => p.pageId);
    const wanted = strFlag(args, 'page');
    let chosen = pages.length === 1 && !wanted ? pages[0] : undefined;
    if (!chosen) {
      if (!wanted) {
        throw new IntegrationUsageError(`--page is required: configured pages are ${ids.join(', ')}.`);
      }
      chosen = pages.find((p) => p.pageId === wanted);
      if (!chosen) {
        throw new IntegrationUsageError(`Page "${wanted}" chưa được cấu hình. Configured pages are ${ids.join(', ')}.`);
      }
    }
    return {
      pageId: chosen.pageId,
      client: createPancakePagesClient({
        pageId: chosen.pageId, pageAccessToken: chosen.token, signal: ctx.signal, ...http,
      }),
    };
  }

  async function pickWarehouse(client: PancakePosClient): Promise<string> {
    const warehouses = await client.listWarehouses();
    if (warehouses.length === 1) return String(warehouses[0].id);
    const list = warehouses.map((w) => `${w.id} (${w.name ?? '?'})`).join(', ');
    throw new IntegrationUsageError(
      warehouses.length === 0
        ? 'Shop chưa có kho nào: tạo kho trong Pancake POS trước.'
        : `--warehouse is required: this shop has several warehouses: ${list}.`,
    );
  }

  function parseItems(raw: string): Obj[] {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const [sku, qtyRaw, priceRaw] = entry.split(':').map((s) => s.trim());
      const qty = qtyRaw === undefined || qtyRaw === '' ? 1 : Number(qtyRaw);
      if (!sku || !Number.isInteger(qty) || qty < 1) {
        throw new IntegrationUsageError(`Mặt hàng "${entry}" sai định dạng. Dùng SKU:số_lượng[:giá], ví dụ AO01:2:150000.`);
      }
      const item: Obj = { variation_id: sku, quantity: qty };
      if (priceRaw !== undefined && priceRaw !== '') {
        const price = Number(priceRaw);
        if (!Number.isFinite(price) || price < 0) {
          throw new IntegrationUsageError(`Giá "${priceRaw}" trong "${entry}" không hợp lệ.`);
        }
        item.variation_info = { retail_price: price };
      }
      return item;
    });
    if (items.length === 0) throw new IntegrationUsageError('--items không có mặt hàng nào. Ví dụ: --items "AO01:2:150000,QUAN02:1".');
    return items;
  }

  // ── POS ───────────────────────────────────────────────────────────────

  const shops: IntegrationCommand = {
    name: 'shops',
    access: 'read',
    usage: '',
    description: 'List the shops this API key can access (id, name, connected chat pages). Other commands use the stored shop; pass --shop <id> to override.',
    async run(ctx, args) {
      assertFlags(args, []);
      const list = await posClient(ctx).listShops();
      return {
        defaultShopId: ctx.values.shop_id || undefined,
        shops: list.map((s) => clean({
          id: String(s.id),
          name: s.name,
          preferred: s.preferred_shop || undefined,
          pages: s.pages?.map((p) => clean({ id: p.id, name: p.name, platform: p.platform })),
        })),
      };
    },
  };

  const ordersList: IntegrationCommand = {
    name: 'orders list',
    access: 'read',
    usage: '[--status <code|name>[,...]] [--since 7d] [--until <date>] [--search <phone|name|note>] [--customer <id>] [--page N] [--limit N] [--sort newest|oldest|updated] [--shop <id>] [--full]',
    description: 'List orders, newest first. --since/--until take 24h, 7d, 2026-10-01 or unix seconds. Statuses: see `statuses`.',
    async run(ctx, args) {
      assertFlags(args, ['status', 'since', 'until', 'search', 'customer', 'page', 'limit', 'sort', 'shop', 'full']);
      const client = await posClientWithShop(ctx, args);
      const limit = limitFlag(args);
      const page = intFlag(args, 'page', { min: 1 });
      const statusRaw = strFlag(args, 'status');
      const sortName = strFlag(args, 'sort') ?? 'newest';
      const sorts: Record<string, string> = {
        newest: 'inserted_at_desc', oldest: 'inserted_at_asc', updated: 'last_updated_order_desc',
      };
      if (!sorts[sortName]) throw new IntegrationUsageError(`--sort phải là newest, oldest hoặc updated, nhận được "${sortName}".`);
      const sinceRaw = strFlag(args, 'since');
      const untilRaw = strFlag(args, 'until');

      const raw: Obj = await client.listOrders({
        pageSize: limit,
        pageNumber: page,
        search: strFlag(args, 'search'),
        filterStatus: statusRaw ? statusRaw.split(',').map((s) => statusFromArg(s.trim())) : undefined,
        startDateTime: sinceRaw ? parseTimeArg(sinceRaw) : undefined,
        endDateTime: untilRaw ? parseTimeArg(untilRaw, { endOfDay: true }) : undefined,
        updateStatus: sortName === 'updated' ? 'updated_at' : 'inserted_at',
        optionSort: sorts[sortName],
        customerId: strFlag(args, 'customer'),
      });
      if (boolFlag(args, 'full')) return raw;
      return listResult(raw, dataArray(raw).map(compactOrder), limit, page);
    },
  };

  const ordersGet: IntegrationCommand = {
    name: 'orders get',
    access: 'read',
    usage: '<orderId> [--shop <id>] [--full]',
    description: 'Get one order by id (the `id` from `orders list`). --full returns the raw API object with every field.',
    async run(ctx, args) {
      assertFlags(args, ['shop', 'full']);
      const id = requirePositional(args, 0, 'orderId', 'orders get 12345');
      const order = await (await posClientWithShop(ctx, args)).getOrder(id);
      return boolFlag(args, 'full') ? order : compactOrder(order);
    },
  };

  const ordersCreate: IntegrationCommand = {
    name: 'orders create',
    access: 'write',
    usage: '--name <customer> --phone <phone> --address "<free text>" --items "SKU:qty[:price],..." [--warehouse <id>] [--note <text>] [--shipping-fee N] [--conversation <id> --page-id <id>] [--shop <id>]  |  --json \'<order body>\'',
    description: 'Create a real order. Convenience flags build the body (the server parses the free-text address); --json passes a full Pancake order body instead (shop_id is injected). The warehouse is picked automatically only when the shop has exactly one.',
    async run(ctx, args) {
      assertFlags(args, [
        'name', 'phone', 'address', 'items', 'warehouse', 'note', 'shipping-fee',
        'conversation', 'page-id', 'json', 'shop',
      ]);
      const client = await posClientWithShop(ctx, args);
      let body: Obj;

      const jsonRaw = strFlag(args, 'json');
      if (jsonRaw !== undefined) {
        try {
          const parsed = JSON.parse(jsonRaw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          body = parsed;
        } catch {
          throw new IntegrationUsageError('--json không phải JSON object hợp lệ. Bọc trong nháy đơn, ví dụ --json \'{"bill_full_name":"A","items":[...]}\'.');
        }
      } else {
        const missing = (['name', 'phone', 'address', 'items'] as const).filter((f) => !strFlag(args, f));
        if (missing.length) {
          throw new IntegrationUsageError(
            `Thiếu ${missing.map((f) => `--${f}`).join(', ')}. Cần --name, --phone, --address, --items "SKU:qty[:price],..." (hoặc dùng --json).`,
          );
        }
        const name = strFlag(args, 'name')!;
        const phone = strFlag(args, 'phone')!;
        body = {
          bill_full_name: name,
          bill_phone_number: phone,
          shipping_address: {
            full_name: name,
            phone_number: phone,
            address: strFlag(args, 'address'),
            province_id: '',
            district_id: '',
            commune_id: '',
          },
          items: parseItems(strFlag(args, 'items')!),
        };
        const fee = intFlag(args, 'shipping-fee', { min: 0 });
        if (fee !== undefined) body.shipping_fee = fee;
        const note = strFlag(args, 'note');
        if (note) body.note = note;
        const conversation = strFlag(args, 'conversation');
        const pageId = strFlag(args, 'page-id');
        if (conversation && !pageId) throw new IntegrationUsageError('--conversation cần đi kèm --page-id <pageId>.');
        if (conversation) body.conversation_id = conversation;
        if (pageId) body.page_id = pageId;
        const wh = strFlag(args, 'warehouse');
        if (wh) body.warehouse_id = wh;
      }

      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new IntegrationUsageError('Đơn hàng cần ít nhất một mặt hàng (items).');
      }
      if (!body.warehouse_id) body.warehouse_id = await pickWarehouse(client);
      const shopNumeric = Number(client.shopId);
      body.shop_id = Number.isFinite(shopNumeric) ? shopNumeric : client.shopId;

      const res = unwrapEntity(await client.createOrder(body));
      return { created: true, order: res.id !== undefined ? compactOrder(res) : res };
    },
  };

  const ordersSetStatus: IntegrationCommand = {
    name: 'orders set-status',
    access: 'write',
    // Cancelling or deleting an order destroys work: it asks the owner even under a write grant.
    riskOf: (args) => {
      const code = parseOrderStatus(args.positionals[1] ?? '');
      return code === 6 || code === 7 ? 'destructive' : 'write';
    },
    usage: '<orderId> <status> [--shop <id>]',
    description: 'Change an order status (code or name, see `statuses`). The request shape (PUT {status}) is inferred from the API docs, not confirmed: check with `orders get` afterwards.',
    async run(ctx, args) {
      assertFlags(args, ['shop']);
      const id = requirePositional(args, 0, 'orderId', 'orders set-status 12345 confirmed');
      const statusRaw = requirePositional(args, 1, 'trạng thái', `orders set-status ${id} confirmed (xem \`statuses\`)`);
      const code = statusFromArg(statusRaw);
      const res = unwrapEntity(await (await posClientWithShop(ctx, args)).updateOrder(id, { status: code }));
      return {
        updated: true,
        orderId: id,
        status: { code, name: orderStatusName(code) },
        order: res.id !== undefined ? compactOrder(res) : undefined,
      };
    },
  };

  const customersSearch: IntegrationCommand = {
    name: 'customers search',
    access: 'read',
    usage: '<keyword> [--limit N] [--shop <id>] [--full]',
    description: 'Find customers by phone number or name. This is how to look a customer up by phone before reading their orders.',
    async run(ctx, args) {
      assertFlags(args, ['limit', 'shop', 'full']);
      const keyword = args.positionals.join(' ').trim();
      if (!keyword) throw new IntegrationUsageError('Thiếu từ khóa. Ví dụ: customers search 0912345678');
      const limit = limitFlag(args);
      const raw: Obj = await (await posClientWithShop(ctx, args)).listCustomers({ search: keyword, pageSize: limit });
      if (boolFlag(args, 'full')) return raw;
      return listResult(raw, dataArray(raw).map(compactCustomer), limit, undefined);
    },
  };

  const customersGet: IntegrationCommand = {
    name: 'customers get',
    access: 'read',
    usage: '<customerId> [--shop <id>] [--full]',
    description: 'Get one customer by id (the `id` from `customers search` or an order\'s customer.id).',
    async run(ctx, args) {
      assertFlags(args, ['shop', 'full']);
      const id = requirePositional(args, 0, 'customerId', 'customers get <id>');
      const customer = await (await posClientWithShop(ctx, args)).getCustomer(id);
      return boolFlag(args, 'full') ? customer : compactCustomer(customer);
    },
  };

  const productsSearch: IntegrationCommand = {
    name: 'products search',
    access: 'read',
    usage: '<keyword> [--limit N] [--shop <id>] [--full]',
    description: 'Search product variations by name or SKU, with sellable stock overall and per warehouse. A variation `sku`/`id` goes into `orders create --items`.',
    async run(ctx, args) {
      assertFlags(args, ['limit', 'shop', 'full']);
      const keyword = args.positionals.join(' ').trim();
      if (!keyword) throw new IntegrationUsageError('Thiếu từ khóa. Ví dụ: products search "áo sơ mi"');
      const limit = limitFlag(args);
      const raw: Obj = await (await posClientWithShop(ctx, args)).listVariations({ search: keyword, pageSize: limit });
      if (boolFlag(args, 'full')) return raw;
      return listResult(raw, dataArray(raw).map(compactVariation), limit, undefined);
    },
  };

  const productsLowStock: IntegrationCommand = {
    name: 'products low-stock',
    access: 'read',
    usage: '[--max 5] [--limit N] [--shop <id>] [--full]',
    description: 'List variations whose sellable stock is at or below --max (default 5), across all warehouses.',
    async run(ctx, args) {
      assertFlags(args, ['max', 'limit', 'shop', 'full']);
      const max = intFlag(args, 'max', { min: 0 }) ?? 5;
      const limit = limitFlag(args);
      const raw: Obj = await (await posClientWithShop(ctx, args)).listVariations({ remainAtMost: max, pageSize: limit });
      if (boolFlag(args, 'full')) return raw;
      return { maxStock: max, ...listResult(raw, dataArray(raw).map(compactVariation), limit, undefined) };
    },
  };

  const warehouses: IntegrationCommand = {
    name: 'warehouses',
    access: 'read',
    usage: '[--shop <id>]',
    description: 'List the shop warehouses (id, name, address). `orders create` needs a warehouse id when the shop has more than one.',
    async run(ctx, args) {
      assertFlags(args, ['shop']);
      const list = await (await posClientWithShop(ctx, args)).listWarehouses();
      return {
        warehouses: list.map((w) => clean({
          id: String(w.id), name: w.name, address: w.full_address, phone: w.phone_number,
        })),
      };
    },
  };

  const statuses: IntegrationCommand = {
    name: 'statuses',
    access: 'read',
    usage: '',
    description: 'The order status table (no API call). Statuses can be given by code or by name, e.g. `--status confirmed,shipped` or `--status 1,2`.',
    async run(_ctx, args) {
      assertFlags(args, []);
      return {
        statuses: ORDER_STATUSES.map((s) => ({ code: s.code, name: s.name })),
        usage: 'Pass a code or the English name (lowercase, spaces or dashes: "waiting-for-confirmation") or the Vietnamese one ("da-xac-nhan", "huy").',
      };
    },
  };

  // ── Pages (chat) ──────────────────────────────────────────────────────

  const pages: IntegrationCommand = {
    name: 'pages',
    access: 'read',
    usage: '',
    description: 'List the chat page ids configured for this integration (use them with --page).',
    async run(ctx, args) {
      assertFlags(args, []);
      const list = parsePageTokens(ctx.values.page_tokens);
      if (list.length === 0) {
        throw new IntegrationUsageError('Chưa nhập page access token Pancake. Chủ cần nhập ở trang Integrations (định dạng page_id:token).');
      }
      return { pages: list.map((p) => p.pageId) };
    },
  };

  const conversationsList: IntegrationCommand = {
    name: 'conversations list',
    access: 'read',
    usage: '[--page <id>] [--type inbox|comment] [--unread] [--since 24h] [--tag <tagId>] [--before <lastConversationId>]',
    description: 'List chat conversations of a page, newest first, 60 per call. --before takes the `next` cursor of the previous call. No phone search here: find the customer with `customers search`, then use the order\'s conversationId.',
    async run(ctx, args) {
      assertFlags(args, ['page', 'type', 'unread', 'since', 'tag', 'before']);
      const { client, pageId } = pageClient(ctx, args);
      const typeRaw = strFlag(args, 'type')?.toLowerCase();
      if (typeRaw && typeRaw !== 'inbox' && typeRaw !== 'comment') {
        throw new IntegrationUsageError(`--type phải là inbox hoặc comment, nhận được "${typeRaw}".`);
      }
      const sinceRaw = strFlag(args, 'since');
      let since: number | undefined;
      let until: number | undefined;
      if (sinceRaw) {
        since = parseTimeArg(sinceRaw);
        until = Math.floor(Date.now() / 1000);
        if (until - since > MAX_CHAT_RANGE_SECONDS) {
          throw new IntegrationUsageError('--since quá xa: Pancake chat chỉ cho khoảng tối đa 1 tháng. Dùng --since 30d hoặc nhỏ hơn, rồi phân trang bằng --before.');
        }
      }
      const raw: Obj = await client.listConversations({
        lastConversationId: strFlag(args, 'before'),
        types: typeRaw ? [typeRaw.toUpperCase() as 'INBOX' | 'COMMENT'] : undefined,
        tags: strFlag(args, 'tag'),
        since,
        until,
        unreadFirst: boolFlag(args, 'unread'),
      });
      let items: Obj[] = Array.isArray(raw.conversations) ? raw.conversations : [];
      if (boolFlag(args, 'unread')) items = items.filter((c) => c.seen === false);
      const mapped = items.map((c) => clean({
        id: c.id !== undefined ? String(c.id) : undefined,
        type: c.type,
        customer: c.from?.name,
        customerId: c.from?.id !== undefined ? String(c.from.id) : undefined,
        snippet: typeof c.snippet === 'string' ? c.snippet.slice(0, 200) : undefined,
        unread: c.seen === false ? true : undefined,
        messages: num(c.message_count),
        hasPhone: c.has_phone || undefined,
        phones: Array.isArray(c.recent_phone_numbers)
          ? c.recent_phone_numbers.map((p: any) => (typeof p === 'string' ? p : p?.phone_number ?? p?.captured)).filter(Boolean)
          : undefined,
        lastSentBy: c.last_sent_by?.name ?? (typeof c.last_sent_by === 'string' ? c.last_sent_by : undefined),
        updatedAt: iso(c.updated_at),
        tags: Array.isArray(c.tags) ? c.tags : undefined,
        postId: c.post_id || undefined,
      }));
      const last = (Array.isArray(raw.conversations) ? raw.conversations : []).at(-1);
      return clean({
        page: pageId,
        count: mapped.length,
        next: last?.id !== undefined ? String(last.id) : undefined,
        items: mapped,
      });
    },
  };

  function plainText(s: unknown): string | undefined {
    if (typeof s !== 'string' || !s) return undefined;
    const text = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    return text || undefined;
  }

  const messages: IntegrationCommand = {
    name: 'messages',
    access: 'read',
    usage: '<conversationId> [--page <id>] [--offset N]',
    description: 'Read the messages of a conversation, 30 per call, returned oldest first. For older messages pass --offset <the `nextOffset` of the previous call>.',
    async run(ctx, args) {
      assertFlags(args, ['page', 'offset']);
      const conversationId = requirePositional(args, 0, 'conversationId', 'messages <conversationId> --page <pageId>');
      const { client, pageId } = pageClient(ctx, args);
      const offset = intFlag(args, 'offset', { min: 0 });
      const raw: Obj = await client.getMessages(conversationId, offset);
      const list: Obj[] = Array.isArray(raw.messages) ? raw.messages : [];
      const mapped = list
        .map((m) => clean({
          id: m.id !== undefined ? String(m.id) : undefined,
          by: m.from?.id !== undefined ? (String(m.from.id) === pageId ? 'page' : 'customer') : undefined,
          from: m.from?.name,
          text: plainText(m.original_message) ?? plainText(m.message),
          at: iso(m.inserted_at),
          attachments: Array.isArray(m.attachments)
            ? m.attachments.map((a: Obj) => clean({ type: a?.type, url: a?.url ?? a?.file_url ?? a?.preview_url }))
            : undefined,
        }))
        .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
      return clean({
        page: pageId,
        conversationId,
        count: mapped.length,
        nextOffset: mapped.length > 0 ? (offset ?? 0) + mapped.length : undefined,
        messages: mapped,
      });
    },
  };

  const tags: IntegrationCommand = {
    name: 'tags',
    access: 'read',
    usage: '[--page <id>]',
    description: 'List the conversation tags of a page (id, text). Tag ids are used by `tag` and `conversations list --tag`.',
    async run(ctx, args) {
      assertFlags(args, ['page']);
      const { client, pageId } = pageClient(ctx, args);
      const list = await client.listTags();
      return { page: pageId, tags: list.map((t) => clean({ id: String(t.id), text: t.text, color: t.color })) };
    },
  };

  const reply: IntegrationCommand = {
    name: 'reply',
    access: 'write',
    usage: '<conversationId> --text "<message>" [--page <id>]',
    description: 'Send a real inbox message to the customer of a conversation. Irreversible: only when the owner or task asked for this exact reply.',
    async run(ctx, args) {
      assertFlags(args, ['text', 'page']);
      const conversationId = requirePositional(args, 0, 'conversationId', 'reply <conversationId> --text "Xin chào" --page <pageId>');
      const text = strFlag(args, 'text');
      if (!text) throw new IntegrationUsageError('Thiếu --text "<nội dung tin nhắn>".');
      const { client, pageId } = pageClient(ctx, args);
      const res: Obj = await client.replyInbox(conversationId, text);
      return clean({ sent: true, page: pageId, conversationId, messageId: res.id !== undefined ? String(res.id) : undefined });
    },
  };

  const tag: IntegrationCommand = {
    name: 'tag',
    access: 'write',
    usage: '<conversationId> <tagId> [--remove] [--page <id>]',
    description: 'Add (default) or remove a tag on a conversation. Tag ids come from `tags`.',
    async run(ctx, args) {
      assertFlags(args, ['remove', 'page']);
      const conversationId = requirePositional(args, 0, 'conversationId', 'tag <conversationId> <tagId>');
      const tagId = requirePositional(args, 1, 'tagId', `tag ${conversationId} <tagId> (xem \`tags\`)`);
      const { client, pageId } = pageClient(ctx, args);
      const action = boolFlag(args, 'remove') ? 'remove' : 'add';
      await client.setConversationTag(conversationId, tagId, action);
      return { ok: true, page: pageId, conversationId, tagId, action };
    },
  };

  return [
    shops, ordersList, ordersGet, ordersCreate, ordersSetStatus,
    customersSearch, customersGet, productsSearch, productsLowStock, warehouses, statuses,
    pages, conversationsList, messages, tags, reply, tag,
  ];
}

export const pancakeCommands: IntegrationCommand[] = buildPancakeCommands();
