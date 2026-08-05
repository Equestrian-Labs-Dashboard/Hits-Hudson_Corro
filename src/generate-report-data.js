import fs from 'node:fs/promises';
import path from 'node:path';

const env = (name, fallback = '') => process.env[name] || fallback;
const required = (name) => {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const repositoryConfig = JSON.parse(await fs.readFile(path.resolve('config/report-config.json'), 'utf8'));

const CONFIG = {
  store: required('SHOPIFY_STORE').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  token: required('SHOPIFY_TOKEN'),
  apiVersion: repositoryConfig.shopifyApiVersion || '2026-07',
  locationId: String(repositoryConfig.locationId || '67063775290'),
  locationName: repositoryConfig.locationName || 'Corro Trailer 1',
  orderTag: repositoryConfig.orderTag || 'HitsHudson',
  projectWeeks: Number(repositoryConfig.projectWeeks || 12),
  projectStart: repositoryConfig.projectStart || '2026-06-01'
};

const MODEL = {
  trailer: 40000,
  setupFurniture: 800,
  otherCapex: 1321.62,
  marketingBudget: 1000,
  discountReturnRate: 0.15,
  grossMarginTarget: 0.60,
  payrollWeekly: 660,
  nicoleWeekly: 660, // backwards-compatible alias
  hotelWeekly: 1400,
  marketingActivationsTotal: 638.33,
  marketingActivations: 638.33, // backwards-compatible alias
  othersTotal: 272,
  others: 272, // backwards-compatible alias
  marketingActivationsDetail: {
    activations: 100,
    wines: 305,
    vistaPrint: 138.22,
    priceChopperSnackShackProduce: [53.88, 41.23]
  },
  othersDetail: {
    cleaners: [125, 125],
    storageBox: 22
  },
  otherCapexNote: 'Manual amount from the prior model; detailed source is pending confirmation.'
};
MODEL.capex = MODEL.trailer + MODEL.setupFurniture + MODEL.otherCapex;
MODEL.weeklyOpex = MODEL.payrollWeekly + MODEL.hotelWeekly;
MODEL.oneTimeOpex = MODEL.marketingActivationsTotal + MODEL.othersTotal;
MODEL.opex = MODEL.weeklyOpex + MODEL.oneTimeOpex;

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const money = (set, fallback = 0) => round2(set?.shopMoney?.amount ?? fallback);
const numericId = (gid = '') => String(gid).split('/').pop();
const nodes = (connection) => (connection?.edges || []).map((e) => e.node).filter(Boolean);
const dateOnly = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00`);
const isoDay = (d) => d.toISOString().slice(0, 10);

async function graphql(query, variables) {
  const response = await fetch(`https://${CONFIG.store}/admin/api/${CONFIG.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': CONFIG.token
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Shopify GraphQL HTTP ${response.status}: ${text.slice(0, 1200)}`);
  const body = JSON.parse(text);
  if (body.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function loadGoals() {
  const goalsFile = path.resolve('config/goals.json');
  const body = JSON.parse(await fs.readFile(goalsFile, 'utf8'));
  const weeks = Array.isArray(body) ? body : body.weeks;
  if (!Array.isArray(weeks) || !weeks.length) {
    throw new Error('config/goals.json has no usable weeks.');
  }
  return weeks.map((w) => ({
    week: Number(w.week),
    startISO: String(w.startISO || ''),
    endISO: String(w.endISO || ''),
    goal: round2(w.goal)
  })).filter((w) => w.week && /^\d{4}-\d{2}-\d{2}$/.test(w.startISO) && /^\d{4}-\d{2}-\d{2}$/.test(w.endISO))
    .sort((a, b) => a.week - b.week)
    .slice(0, CONFIG.projectWeeks);
}

const ORDER_QUERY = `
query HitsHudsonOrders($cursor: String, $q: String!, $first: Int!, $lineFirst: Int!) {
  orders(first: $first, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name tags createdAt sourceName displayFinancialStatus displayFulfillmentStatus cancelledAt closed closedAt email
      app { name }
      physicalLocation { id name }
      fulfillments(first: 20) { location { id name } }
      customer { firstName lastName email }
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      netPaymentSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      refunds { refundLineItems(first: 100) { edges { node { quantity subtotalSet { shopMoney { amount currencyCode } } } } } }
      lineItems(first: $lineFirst) { pageInfo { hasNextPage endCursor } edges { node {
        id title quantity sku variantTitle
        originalTotalSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } }
        totalDiscountSet { shopMoney { amount currencyCode } }
        product { id title tags }
        variant { id sku inventoryItem { id unitCost { amount currencyCode } } }
      } } }
    } }
  }
}`;

async function fetchOrders(startISO, endISO) {
  const all = [];
  let cursor = null;
  const q = `status:any created_at:>=${startISO} created_at:<=${endISO}`;
  do {
    const data = await graphql(ORDER_QUERY, { cursor, q, first: 50, lineFirst: 100 });
    const connection = data.orders;
    all.push(...nodes(connection));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

function deliveryInfo(order) {
  const physical = order.physicalLocation || {};
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : nodes(order.fulfillments);
  const locations = [physical, ...(fulfillments || []).map((f) => f.location)].filter(Boolean);
  const targetName = CONFIG.locationName.toLowerCase();
  const targetId = String(CONFIG.locationId);
  const match = locations.some((l) => String(l.name || '').toLowerCase().includes(targetName) || numericId(l.id) === targetId);
  return { match, name: locations.map((l) => l.name).filter(Boolean).join(', ') || 'No Shopify location returned' };
}

function qualifies(order) {
  const tag = (order.tags || []).some((t) => String(t).toLowerCase() === CONFIG.orderTag.toLowerCase());
  const delivery = deliveryInfo(order);
  return { include: tag || delivery.match, tag, delivery };
}

function orderSummary(order) {
  const lineRows = nodes(order.lineItems).filter((item) => !String(item.title || '').toLowerCase().includes('shipping protection') && String(item.title || '').toLowerCase() !== 'shipping');
  const currentSubtotal = money(order.currentSubtotalPriceSet);
  const discounts = money(order.totalDiscountsSet);
  const refunds = (order.refunds || []).reduce((sum, refund) => sum + nodes(refund.refundLineItems).reduce((s, item) => s + money(item.subtotalSet), 0), 0) || money(order.totalRefundedSet);
  const grossSales = round2(currentSubtotal + discounts + refunds);
  const netSales = currentSubtotal;
  const netBeforeReturns = Math.max(grossSales - discounts, 0);
  const returnFactor = netBeforeReturns > 0 ? Math.max(0, Math.min(1, netSales / netBeforeReturns)) : 0;
  const rawCogs = lineRows.reduce((sum, item) => sum + Number(item.variant?.inventoryItem?.unitCost?.amount || 0) * Number(item.quantity || 0), 0);
  const cogs = round2(rawCogs * returnFactor);
  const grossProfit = round2(netSales - cogs);
  const info = qualifies(order);
  return {
    order_id: order.name || numericId(order.id), order_date: order.createdAt,
    tags: order.tags || [], tag_has_hits: info.tag,
    customer: `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() || 'N/A',
    customer_email: order.customer?.email || order.email || '',
    payment_status: order.displayFinancialStatus || 'UNKNOWN', fulfillment_status: order.displayFulfillmentStatus || 'UNKNOWN',
    location: info.delivery.name, gross_sales: grossSales, discounts: round2(discounts), returns: round2(refunds),
    net_sales: round2(netSales), shipping_charges: money(order.totalShippingPriceSet), taxes: money(order.totalTaxSet),
    total_sales: money(order.netPaymentSet, netSales + money(order.totalShippingPriceSet) + money(order.totalTaxSet)),
    units: lineRows.reduce((s, i) => s + Number(i.quantity || 0), 0), cogs, gross_profit: grossProfit,
    gross_margin: netSales > 0 ? grossProfit / netSales : 0
  };
}

function buildReport(goals, rawOrders) {
  const stats = { scanned: rawOrders.length, matched: 0, excluded: 0 };
  const summaries = [];
  for (const order of rawOrders) {
    if (!qualifies(order).include) { stats.excluded++; continue; }
    summaries.push(orderSummary(order)); stats.matched++;
  }

  const weeks = goals.map((g) => ({ ...g, actual: { gross_sales: 0, discounts: 0, returns: 0, net_sales: 0, gross_profit: 0, total_orders: 0, units: 0, cogs: 0 } }));
  for (const order of summaries) {
    const d = dateOnly(order.order_date);
    const week = weeks.find((w) => d >= dateOnly(w.startISO) && d <= dateOnly(w.endISO));
    if (!week) continue;
    const a = week.actual;
    for (const key of ['gross_sales', 'discounts', 'returns', 'net_sales', 'gross_profit', 'units', 'cogs']) a[key] += Number(order[key] || 0);
    a.total_orders++;
  }
  for (const w of weeks) {
    for (const k of Object.keys(w.actual)) w.actual[k] = round2(w.actual[k]);
    w.actual.gross_margin = w.actual.net_sales > 0 ? w.actual.gross_profit / w.actual.net_sales : 0;
  }

  return {
    generated_at: new Date().toISOString(),
    config: { location_id: CONFIG.locationId, location_name: CONFIG.locationName, order_tag: CONFIG.orderTag, api_version: CONFIG.apiVersion },
    assumptions: { ...MODEL }, weeks, orders: summaries, stats,
    formulas: {
      budget_net_sales: 'Gross Sales Goal × (1 − Discounts & Returns %)',
      budget_gross_profit: 'Budget Net Sales × Gross Margin %',
      weekly_opex: 'Payroll / Personnel Weekly Cost + Hotel Weekly Cost',
      one_time_opex: 'Marketing / Activations Total Cost + Others Total Cost; deducted once in the first included week',
      budget_weekly_contribution: 'Budget Gross Profit + Marketing Income Budget − Weekly OPEX',
      actual_weekly_contribution: 'Shopify Actual Gross Profit + Manual Marketing Actual − Manual Weekly OPEX Actual; one-time OPEX is deducted once',
      actual_forecast_cumulative_cash: '−CAPEX + actual contributions for started weeks + budget contributions for future weeks − one-time OPEX once',
      actual_only_cumulative_cash: '−CAPEX + actual contributions for started weeks only',
      payback: 'First included week where cumulative cash is greater than or equal to zero'
    }
  };
}

async function main() {
  const goals = await loadGoals();
  if (!goals.length) throw new Error('No valid GOALS rows were found.');
  const rawOrders = await fetchOrders(goals[0].startISO, goals.at(-1).endISO);
  const report = buildReport(goals, rawOrders);
  const out = path.resolve('docs/report-data.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Generated ${out}: ${report.stats.matched} matched orders across ${report.weeks.length} weeks.`);
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
