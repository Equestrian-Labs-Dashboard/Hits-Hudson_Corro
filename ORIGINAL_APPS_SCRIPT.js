// ============================================================
// HITS Hudson — Initial Sales Report
// Google Apps Script Backend
// ------------------------------------------------------------
// Purpose:
//   Trailer/HITS Hudson will exist as its own Shopify storefront/POS location.
//   Orders should also be tagged with: HitsHudson
//
// Main rule:
//   Include an order when it is in the selected date range and EITHER:
//     1) the order belongs to Corro Trailer 1 Shopify warehouse/location, OR
//     2) the order has the ORDER TAG HitsHudson.
//
// Notes:
//   HitsHudson must be read from Shopify order.tags only. It is not a product tag.
//   This also allows draft orders tagged HitsHudson to count toward the show.
// ============================================================

const PROPS       = PropertiesService.getScriptProperties();
const STORE       = PROPS.getProperty('SHOPIFY_STORE');
const TOKEN       = PROPS.getProperty('SHOPIFY_TOKEN');
const API_VERSION = PROPS.getProperty('SHOPIFY_API_VERSION') || '2024-10';

// REQUIRED: add this Script Property after Shopify creates the trailer location.
// Example value format: 63267766330
const HITS_LOCATION_ID   = PROPS.getProperty('HITS_LOCATION_ID') || '67063775290';

// Optional, used only as display/evidence. Exact name can be adjusted later.
const HITS_LOCATION_NAME = PROPS.getProperty('HITS_LOCATION_NAME') || 'Corro Trailer 1';

// Required order tag. Do not use only HITS; HitsHudson avoids confusion if trailer moves.
const HITS_ORDER_TAG     = PROPS.getProperty('HITS_ORDER_TAG') || 'HitsHudson';

// HITS now counts everything assigned to the Corro Trailer 1 warehouse/location.
// Source and tag are shown as audit fields, but they do not exclude the order.
const EXCLUDE_ONLINE_ORDERS = false;
const POS_SOURCE_NAMES = ['pos', 'shopify_pos', 'point of sale', 'shopify pos'];
const ONLINE_SOURCE_NAMES = ['web', 'online_store', 'online store', 'shopify_draft_order', 'draft order'];

const GRAPHQL_ORDER_PAGE_SIZE = 50;
const GRAPHQL_LINE_PAGE_SIZE  = 100;
const PRODUCT_AUDIT_TAGS = ['drop ship', 'drop_ship', 'shopify collective', 'dropship', 'autoship'];


// ── 12-week show / 12-week calculation Payback assumptions ─────────────────
// These match the CAPEX / Sales / OPEX / Profit table from the audio/image.
const PROJECT_WEEKS = 12; // Show only 12 formal show weeks from the GOALS sheet.
const PROJECT_CALC_START_WEEK = 1; // Week 1 of June counts unless marked as Off Week in the dashboard.
const PROJECT_CALC_WEEKS = 12; // Target number of formal show weeks shown; off weeks are excluded dynamically in the browser.
const PROJECT_TRAILER_COST = 40000;
const PROJECT_SETUP_FURNITURE_COST = 800;
const PROJECT_OTHER_CAPEX_COSTS = 1321.62;
const PROJECT_CAPEX = PROJECT_TRAILER_COST + PROJECT_SETUP_FURNITURE_COST + PROJECT_OTHER_CAPEX_COSTS;
const PROJECT_WEEKLY_GROSS_SALES_BUDGET = 14000;
const PROJECT_WEEKLY_MARKETING_INCOME_BUDGET = 1000;
const PROJECT_DISCOUNTS_RETURNS_RATE = 0.15;
const PROJECT_GROSS_MARGIN_TARGET = 0.60;
const PROJECT_WEEKLY_OPEX_BUDGET = 2532;

// Default model from the latest HITS discussion:
// Net Sales 11,900 · Profit / weekly contribution 5,608 · Week 1 counts. Off weeks can be excluded dynamically in the dashboard.
const PROJECT_WEEKLY_NET_SALES_BUDGET = 11900;
const PROJECT_WEEKLY_GROSS_PROFIT_BUDGET = 5608;
const PROJECT_WEEKLY_CONTRIBUTION_BUDGET = 5608;
const PROJECT_DEFAULT_START_DATE = '2026-06-01';
const PROJECT_GOALS_SPREADSHEET_ID = '1riy2kGsv1yDgzALB9hqEicV3e1t2AygzQKtc_cNmvW4';
const PROJECT_GOALS_SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1riy2kGsv1yDgzALB9hqEicV3e1t2AygzQKtc_cNmvW4/edit?gid=0#gid=0';
const PROJECT_GOALS_SHEET_NAME = 'GOALS';
const PROJECT_GOALS_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + PROJECT_GOALS_SPREADSHEET_ID + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(PROJECT_GOALS_SHEET_NAME);

// Cache / quota control. Shopify calls use UrlFetchApp and can hit daily quotas.
// Keep a short cache so Refresh does not repeatedly call Shopify.
const HITS_CACHE_VERSION = '2026-06-24-cache-control-v1';
const HITS_SHOPIFY_CACHE_SECONDS = 300; // 5 minutes
const HITS_GOALS_CACHE_SECONDS = 1800; // 30 minutes; uses SpreadsheetApp, not UrlFetchApp.



// ── Cache helpers / quota control ────────────────────────────────────────────

function cacheKey_(prefix, payload) {
  var raw = HITS_CACHE_VERSION + ':' + prefix + ':' + JSON.stringify(payload || {});
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return prefix + ':' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
}

function cacheGetJson_(key) {
  try {
    var hit = CacheService.getScriptCache().get(key);
    return hit ? JSON.parse(hit) : null;
  } catch (e) {
    return null;
  }
}

function cachePutJson_(key, value, seconds) {
  try {
    var text = JSON.stringify(value);
    // Apps Script cache has a per-item size limit. Skip large payloads safely.
    if (text && text.length < 95000) {
      CacheService.getScriptCache().put(key, text, seconds || HITS_SHOPIFY_CACHE_SECONDS);
    }
  } catch (e) {}
}

function clearHitsCache() {
  // Apps Script CacheService cannot list/delete by prefix. Bump HITS_CACHE_VERSION
  // when a hard cache reset is required.
  return 'Cache is controlled by HITS_CACHE_VERSION. Current version: ' + HITS_CACHE_VERSION;
}

// ── Web App ──────────────────────────────────────────────────────────────────

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('HITS Hudson Sales Report')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Public API ────────────────────────────────────────────────────────────────

function isProjectCalculationWeek_(w) {
  return Number(w && w.week) >= PROJECT_CALC_START_WEEK;
}

function getWeekOptions(numWeeks) {
  // Primary source: the GOALS Google Sheet. This makes the By Week filter match
  // Week 1 = Jun 1-Jun 7, Week 2 = Jun 8-Jun 14, etc.
  var goalPack = getProjectGoalsFromSheet_();
  if (goalPack && goalPack.weeks && goalPack.weeks.length) {
    return goalPack.weeks.map(function(w) {
      var s = parseLocalDate_(w.startISO);
      var e = parseLocalDate_(w.endISO);
      return {
        label: 'Week ' + w.week + ' · ' + fmtShort_(s) + ' – ' + fmtShort_(e) + ' · Goal ' + formatMoney0_(w.goal),
        startISO: w.startISO,
        endISO: w.endISO,
        week: w.week,
        goal: w.goal,
        include_in_calculation: isProjectCalculationWeek_(w),
        calculation_note: isProjectCalculationWeek_(w) ? 'Included in active show-week calculation' : 'Not included in final calculation',
        source: goalPack.source
      };
    });
  }

  // Fallback only if the sheet cannot be read.
  numWeeks = numWeeks || 12;
  var now = new Date();
  var day = now.getDay();
  var diff = (day === 0) ? 6 : day - 1;
  var thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  var options = [];

  for (var i = 0; i < numWeeks; i++) {
    var mon = new Date(thisMonday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    var sun = new Date(mon.getTime() + 6 * 24 * 60 * 60 * 1000);
    var label = fmtShort_(mon) + ' – ' + fmtShort_(sun);
    if (i === 0) label = 'This week · ' + label;
    if (i === 1) label = 'Last week · ' + label;
    options.push({ label: label, startISO: isoDay_(mon), endISO: isoDay_(sun) });
  }
  return options;
}

function getMonthOptions() {
  // Month filter must only show months covered by the GOALS sheet weeks.
  var pack = getProjectGoalsFromSheet_();
  var map = {};
  (pack.weeks || []).forEach(function(w) {
    var d = parseLocalDate_(w.startISO);
    if (!d) return;
    var key = d.getFullYear() + ':' + (d.getMonth() + 1);
    if (!map[key]) {
      map[key] = {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        label: monthName_(d.getMonth() + 1) + ' ' + d.getFullYear(),
        goal: 0,
        display_goal: 0,
        weeks: [],
        display_weeks: []
      };
    }
    map[key].display_goal = round2_(map[key].display_goal + Number(w.goal || 0));
    map[key].display_weeks.push(w.week);
    if (isProjectCalculationWeek_(w)) {
      map[key].goal = round2_(map[key].goal + Number(w.goal || 0));
      map[key].weeks.push(w.week);
    }
  });
  return Object.keys(map).sort(function(a,b) {
    var pa = a.split(':');
    var pb = b.split(':');
    return (Number(pa[0]) - Number(pb[0])) || (Number(pa[1]) - Number(pb[1]));
  }).map(function(k) {
    var m = map[k];
    m.value = m.year + ':' + m.month;
    m.label = m.label + ' · 12-week calc goal ' + formatMoney0_(m.goal);
    m.display_label = m.label;
    m.source = pack.source;
    m.note = 'Monthly goal includes every GOALS Sheet week that starts inside the selected month.';
    return m;
  });
}

function getHitsData(params) {
  params = params || {};
  validateConfig_();

  var range = resolveDateRange_(params);
  var dataCacheKey = cacheKey_('hitsData', { mode: params.mode || '', start: range.startDay, end: range.endDay, label: range.periodLabel });
  if (!params.forceFresh) {
    var cachedData = cacheGetJson_(dataCacheKey);
    if (cachedData) {
      cachedData.cache_status = 'Loaded from cache to protect Shopify UrlFetch quota';
      return cachedData;
    }
  }

  var query = buildHitsQuery_(range.startDay, range.endDay);
  var pack = fetchGraphQLOrders_(query);
  if (pack.error) return { error: pack.error };

  var stats = {
    api_mode: 'GraphQL Admin API',
    report: 'HITS Hudson Initial Sales Report',
    location_id_required: String(HITS_LOCATION_ID),
    location_required: HITS_LOCATION_NAME,
    order_tag_audit: HITS_ORDER_TAG,
    warehouse_filter: HITS_LOCATION_NAME,
    graphql_query: query,
    total_orders_scanned: (pack.orders || []).length,
    matched_orders: 0,
    matched_lines: 0,
    online_orders_skipped: 0,
    unknown_source_orders: 0,
    pos_source_orders: 0,
    location_skipped: 0,
    orders_with_hits_tag: 0,
    tag_only_orders: 0,
    cogs_missing_lines: 0,
    line_items_page_limit: GRAPHQL_LINE_PAGE_SIZE
  };

  var orders = [];
  var lines = [];
  var summary = emptySummary_();

  (pack.orders || []).forEach(function(order) {
    if (!qualifiesHitsSource_(order, stats)) return;

    var lineRows = buildLineRows_(order, stats);
    // Include the order summary even if line items are missing/empty so Shopify order totals still reconcile.
    var orderSummary = buildOrderSummary_(order, lineRows);
    orders.push(orderSummary);
    lines = lines.concat(lineRows);
    addToSummary_(summary, orderSummary);
    stats.matched_orders++;
    stats.matched_lines += lineRows.length;
  });

  finalizeMoney_(summary);
  summary.gross_margin = summary.net_sales > 0 ? summary.gross_profit / summary.net_sales : 0;

  orders.sort(function(a,b) { return new Date(b.order_date) - new Date(a.order_date); });
  lines.sort(function(a,b) { return new Date(b.order_date) - new Date(a.order_date); });

  var goalContext = getGoalContextForRange_(range.startDay, range.endDay);

  var result = {
    ok: true,
    generated: new Date().toLocaleString(),
    cache_status: 'Fresh Shopify load',
    period_label: range.periodLabel,
    goal_context: goalContext,
    summary: summary,
    orders: orders,
    lines: lines,
    stats: stats,
    warnings: pack.warnings || [],
    config: {
      location_id_required: String(HITS_LOCATION_ID),
      location_required: HITS_LOCATION_NAME,
      order_tag_audit: HITS_ORDER_TAG,
      validation_example: 'orders(first: 50, query: "status:any created_at:>=YYYY-MM-DD created_at:<=YYYY-MM-DD") then client-side include physicalLocation/fulfillment location = ' + HITS_LOCATION_NAME + ' OR order tag = ' + HITS_ORDER_TAG
    }
  };
  cachePutJson_(dataCacheKey, result, HITS_SHOPIFY_CACHE_SECONDS);
  return result;
}

// ── HITS processing ──────────────────────────────────────────────────────────

function buildLineRows_(order, stats) {
  var delivery = getGraphQLDeliveryInfo_(order);
  var status = getOrderStatusInfo_(order);
  var sourceInfo = getOrderSourceInfo_(order);
  var tagInfo = getOrderTagInfo_(order);
  var out = [];

  (getEdgesNodes_(order.lineItems) || []).forEach(function(item) {
    if (isShippingLine_(item)) return;

    var qty = parseInt(item.quantity || 0, 10);
    var gross = round2_(money_(item.originalTotalSet));
    var discount = round2_(money_(item.totalDiscountSet));
    var net = round2_(money_(item.discountedTotalSet, gross - discount));

    var product = item.product || {};
    var variant = item.variant || {};
    var productTags = product.tags || [];
    var tagAudit = getProductTagAudit_(productTags);

    var unitCogs = 0;
    var cogsStatus = 'OK';
    if (variant && variant.inventoryItem && variant.inventoryItem.unitCost) {
      unitCogs = parseFloat(variant.inventoryItem.unitCost.amount || 0);
    } else {
      cogsStatus = variant && variant.id ? 'COGS missing in Shopify / no unitCost' : 'Missing variant / inventory item';
      stats.cogs_missing_lines++;
    }

    var cogs = round2_(unitCogs * Math.max(qty, 0));
    var grossProfit = round2_(net - cogs);
    var grossMargin = net > 0 ? grossProfit / net : 0;

    out.push({
      order_id: order.name || gqlNumericId_(order.id),
      order_numeric_id: gqlNumericId_(order.id),
      order_date: order.createdAt || '',
      order_tag: tagInfo.tag_status,
      all_order_tags: tagInfo.tags_display,
      tag_has_hits: tagInfo.has_hits_tag,
      customer: customerName_(order.customer),
      customer_email: customerEmail_(order),
      payment_status: status.payment_status,
      financial_status: status.financial_status,
      fulfillment_status: status.fulfillment_status,
      order_status: status.order_status,
      status_summary: status.status_summary,
      refund_status: status.refund_status,
      cancelled_at: status.cancelled_at,
      closed_at: status.closed_at,
      product: item.title || (product.title || ''),
      variant: item.variantTitle || '',
      sku: item.sku || (variant.sku || ''),
      product_id: gqlNumericId_(product.id),
      variant_id: gqlNumericId_(variant.id),
      quantity: qty,
      gross: gross,
      discount: discount,
      net: net,
      unit_cogs: round2_(unitCogs),
      cogs: cogs,
      cogs_status: cogsStatus,
      gross_profit: grossProfit,
      gross_margin: grossMargin,
      delivery_method: delivery.delivery_method,
      is_in_store: delivery.is_in_store,
      location: delivery.location,
      location_id: String(HITS_LOCATION_ID),
      location_evidence: delivery.evidence,
      source_name: sourceInfo.source_name,
      app_name: sourceInfo.app_name,
      source_display: sourceInfo.source_display,
      product_tags: normalizeTags_(productTags).join(', '),
      product_tag_status: tagAudit.status,
      product_tag_audit: tagAudit.is_flagged ? 'Audit only: ' + tagAudit.status + ' product tag' : ''
    });
  });

  return out;
}

function buildOrderSummary_(order, lineRows) {
  var delivery = getGraphQLDeliveryInfo_(order);
  var status = getOrderStatusInfo_(order);
  var sourceInfo = getOrderSourceInfo_(order);
  var tagInfo = getOrderTagInfo_(order);

  var grossSales = orderGrossFromGraphQL_(order);
  var discounts = round2_(money_(order.totalDiscountsSet));
  var returns = round2_(orderProductReturnsFromGraphQL_(order));
  var refundedTotal = round2_(money_(order.totalRefundedSet));
  var refundedTaxShipping = round2_(Math.max(0, refundedTotal - returns));
  var netSales = orderNetSalesFromGraphQL_(order);
  var shippingCharges = round2_(money_(order.totalShippingPriceSet));
  var taxes = round2_(money_(order.totalTaxSet));
  var totalSales = orderTotalSalesFromGraphQL_(order);

  // Adjust line net/COGS for returned/refunded product value.
  var netBeforeReturns = Math.max(grossSales - discounts, 0);
  var returnFactor = netBeforeReturns > 0 ? Math.max(0, Math.min(1, netSales / netBeforeReturns)) : 0;

  lineRows.forEach(function(row) {
    row.net_before_returns = round2_(row.net || 0);
    row.raw_cogs = round2_(row.cogs || 0);
    row.return_cogs_factor = returnFactor;
    row.return_adjustment = round2_(row.net_before_returns - (row.net_before_returns * returnFactor));
    row.net = round2_(row.net_before_returns * returnFactor);
    row.cogs = round2_(row.raw_cogs * returnFactor);
    row.gross_profit = round2_(row.net - row.cogs);
    row.gross_margin = row.net > 0 ? row.gross_profit / row.net : 0;
    row.type = row.net > 0 ? 'HITS Hudson' : (returns > 0 || status.order_status === 'Canceled' ? 'Returned / Canceled' : 'Zero Net');
  });

  var units = lineRows.reduce(function(s, x) { return s + (x.quantity || 0); }, 0);
  var cogs = round2_(lineRows.reduce(function(s, x) { return s + (x.cogs || 0); }, 0));
  var rawCogs = round2_(lineRows.reduce(function(s, x) { return s + (x.raw_cogs || 0); }, 0));
  var grossProfit = round2_(netSales - cogs);

  return {
    order_id: order.name || gqlNumericId_(order.id),
    order_numeric_id: gqlNumericId_(order.id),
    order_date: order.createdAt || '',
    order_tag: tagInfo.tag_status,
    all_order_tags: tagInfo.tags_display,
    tag_has_hits: tagInfo.has_hits_tag,
    customer: customerName_(order.customer),
    customer_email: customerEmail_(order),
    payment_status: status.payment_status,
    financial_status: status.financial_status,
    fulfillment_status: status.fulfillment_status,
    order_status: status.order_status,
    status_summary: status.status_summary,
    refund_status: status.refund_status,
    cancelled_at: status.cancelled_at,
    closed_at: status.closed_at,
    gross_sales: round2_(grossSales),
    discounts: round2_(discounts),
    returns: round2_(returns),
    refunded_total: refundedTotal,
    refunded_tax_shipping: refundedTaxShipping,
    net_sales: round2_(netSales),
    orders: 1,
    shipping_charges: round2_(shippingCharges),
    taxes: round2_(taxes),
    total_sales: round2_(totalSales),
    units: units,
    cogs: cogs,
    raw_cogs: rawCogs,
    return_cogs_factor: returnFactor,
    gross_profit: grossProfit,
    gross_margin: netSales > 0 ? grossProfit / netSales : 0,
    delivery_method: delivery.delivery_method,
    is_in_store: delivery.is_in_store,
    location: delivery.location,
    location_id: String(HITS_LOCATION_ID),
    location_evidence: delivery.evidence,
    source_name: sourceInfo.source_name,
    app_name: sourceInfo.app_name,
    source_display: sourceInfo.source_display,
    line_count: lineRows.length
  };
}

function emptySummary_() {
  return {
    gross_sales: 0,
    gross_profit: 0,
    discounts: 0,
    returns: 0,
    net_sales: 0,
    shipping_charges: 0,
    taxes: 0,
    total_sales: 0,
    total_orders: 0,
    units: 0,
    cogs: 0,
    gross_margin: 0
  };
}

function addToSummary_(s, r) {
  s.gross_sales += r.gross_sales || 0;
  s.gross_profit += r.gross_profit || 0;
  s.discounts += r.discounts || 0;
  s.returns += r.returns || 0;
  s.net_sales += r.net_sales || 0;
  s.shipping_charges += r.shipping_charges || 0;
  s.taxes += r.taxes || 0;
  s.total_sales += r.total_sales || 0;
  s.total_orders += 1;
  s.units += r.units || 0;
  s.cogs += r.cogs || 0;
}

// ── Source / delivery filters ────────────────────────────────────────────────

function qualifiesHitsSource_(order, stats) {
  // Inclusion rule: Corro Trailer 1 warehouse/location OR ORDER TAG HitsHudson.
  // HitsHudson is checked only on order.tags, not product tags.
  // This ensures tagged draft orders count even when Shopify does not attach the trailer location.
  var delivery = getGraphQLDeliveryInfo_(order);
  var sourceInfo = getOrderSourceInfo_(order);
  var tagInfo = getOrderTagInfo_(order);

  if (sourceInfo.is_pos) {
    if (stats) stats.pos_source_orders = (stats.pos_source_orders || 0) + 1;
  } else if (sourceInfo.is_online) {
    if (stats) stats.online_source_orders = (stats.online_source_orders || 0) + 1;
  } else {
    if (stats) stats.unknown_source_orders = (stats.unknown_source_orders || 0) + 1;
  }

  var includeOrder = delivery.matches_hits_location || tagInfo.has_hits_tag;

  if (!includeOrder) {
    if (stats) stats.location_skipped = (stats.location_skipped || 0) + 1;
    return false;
  }

  if (tagInfo.has_hits_tag && stats) stats.orders_with_hits_tag = (stats.orders_with_hits_tag || 0) + 1;
  if (!tagInfo.has_hits_tag && stats) stats.orders_missing_hits_tag = (stats.orders_missing_hits_tag || 0) + 1;
  if (!delivery.matches_hits_location && tagInfo.has_hits_tag && stats) {
    stats.tag_only_orders = (stats.tag_only_orders || 0) + 1;
  }

  return true;
}

function getOrderTagInfo_(order) {
  var tags = normalizeTags_(order && order.tags ? order.tags : []);
  var target = String(HITS_ORDER_TAG).toLowerCase();
  var hasHits = tags.some(function(t) { return String(t).toLowerCase() === target; });
  return {
    tags: tags,
    tags_display: tags.length ? tags.join(', ') : 'No tags',
    has_hits_tag: hasHits,
    tag_status: hasHits ? 'HitsHudson' : 'Missing HitsHudson tag'
  };
}

function getOrderSourceInfo_(order) {
  order = order || {};

  var sourceName = String(order.sourceName || '').trim().toLowerCase();
  var appName = order.app && order.app.name
    ? String(order.app.name).trim().toLowerCase()
    : '';

  var combined = (sourceName + ' ' + appName).trim();

  var isPos = POS_SOURCE_NAMES.some(function(v) {
    return combined.indexOf(String(v).toLowerCase()) >= 0;
  });

  var isOnline = ONLINE_SOURCE_NAMES.some(function(v) {
    return combined.indexOf(String(v).toLowerCase()) >= 0;
  });

  return {
    source_name: order.sourceName || '',
    app_name: order.app && order.app.name ? order.app.name : '',
    source_display: 'sourceName=' + (order.sourceName || 'N/A') + ' · app=' + (order.app && order.app.name ? order.app.name : 'N/A'),
    is_pos: isPos,
    is_online: isOnline
  };
}

function getGraphQLDeliveryInfo_(order) {
  order = order || {};
  var physicalName = order.physicalLocation ? (order.physicalLocation.name || '') : '';
  var physicalId = order.physicalLocation ? gqlNumericId_(order.physicalLocation.id || '') : '';

  var fulfillmentNames = [];
  var fulfillmentIds = [];
  try {
    var fulfillments = order.fulfillments || [];
    if (fulfillments && fulfillments.edges) fulfillments = getEdgesNodes_(fulfillments);
    (fulfillments || []).forEach(function(f) {
      if (f && f.location) {
        if (f.location.name) fulfillmentNames.push(f.location.name);
        if (f.location.id) fulfillmentIds.push(gqlNumericId_(f.location.id));
      }
    });
  } catch(e) {}

  var evidenceParts = [];
  if (physicalName) evidenceParts.push('physicalLocation=' + physicalName + (physicalId ? ' #' + physicalId : ''));
  if (fulfillmentNames.length) evidenceParts.push('fulfillmentLocation=' + uniqueValues_(fulfillmentNames).join(', '));

  var allLocationNames = [physicalName].concat(fulfillmentNames).filter(Boolean);
  var locationOk = allLocationNames.some(function(n) { return containsCI_(n, HITS_LOCATION_NAME); });
  var isInStore = !!locationOk || allLocationNames.length > 0;
  var method = isInStore ? 'IN STORE' : 'UNSPECIFIED';

  return {
    is_in_store: isInStore,
    matches_hits_location: locationOk,
    delivery_method: method,
    location: physicalName || uniqueValues_(fulfillmentNames).join(', ') || 'No Shopify location returned',
    fulfillment_location: uniqueValues_(fulfillmentNames).join(', '),
    location_id: physicalId || uniqueValues_(fulfillmentIds).join(', ') || String(HITS_LOCATION_ID),
    evidence: evidenceParts.length ? evidenceParts.join(' · ') : 'No physicalLocation/fulfillment location returned · expected=' + HITS_LOCATION_NAME
  };
}
// ── Shopify analytics calculations ───────────────────────────────────────────

function orderGrossFromGraphQL_(order) {
  var currentSubtotal = money_(order.currentSubtotalPriceSet);
  var discounts = money_(order.totalDiscountsSet);
  var productReturns = orderProductReturnsFromGraphQL_(order);
  return round2_(currentSubtotal + discounts + productReturns);
}

function orderProductReturnsFromGraphQL_(order) {
  var total = 0;
  (order.refunds || []).forEach(function(refund) {
    (getEdgesNodes_(refund.refundLineItems) || []).forEach(function(ri) {
      total += money_(ri.subtotalSet);
    });
  });

  if (total > 0) return round2_(total);
  return round2_(money_(order.totalRefundedSet));
}

function orderNetSalesFromGraphQL_(order) {
  var currentSubtotal = moneyOrNull_(order.currentSubtotalPriceSet);
  if (currentSubtotal !== null) return round2_(currentSubtotal);
  return round2_(orderGrossFromGraphQL_(order) - money_(order.totalDiscountsSet) - money_(order.totalRefundedSet));
}

function orderTotalSalesFromGraphQL_(order) {
  var netPayment = moneyOrNull_(order.netPaymentSet);
  if (netPayment !== null) return round2_(netPayment);
  return round2_(orderNetSalesFromGraphQL_(order) + money_(order.totalShippingPriceSet) + money_(order.totalTaxSet));
}

function getOrderStatusInfo_(order) {
  order = order || {};
  var financial = prettyStatus_(order.displayFinancialStatus || '');
  var fulfillment = prettyStatus_(order.displayFulfillmentStatus || '');
  var cancelledAt = order.cancelledAt || '';
  var closedAt = order.closedAt || '';
  var isClosed = !!order.closed || !!closedAt;

  var refundedAmount = money_(order.totalRefundedSet);
  var netSales = orderNetSalesFromGraphQL_(order);
  var refundStatus = 'No Refund';
  if (refundedAmount > 0 && netSales <= 0) refundStatus = 'Refunded';
  else if (refundedAmount > 0) refundStatus = 'Partially Refunded';

  var paymentStatus = financial || refundStatus;
  if (refundStatus !== 'No Refund' && (!financial || financial === 'Paid')) paymentStatus = refundStatus;

  var orderStatus = cancelledAt ? 'Canceled' : (isClosed ? 'Archived' : 'Open');

  var parts = [];
  if (orderStatus === 'Canceled') parts.push('Canceled');
  if (paymentStatus) parts.push(paymentStatus);
  if (fulfillment) parts.push(fulfillment);
  if (orderStatus === 'Archived') parts.push('Archived');
  if (!parts.length) parts.push('Status unavailable');

  return {
    payment_status: paymentStatus || 'Unknown',
    financial_status: financial || 'Unknown',
    fulfillment_status: fulfillment || 'Unknown',
    order_status: orderStatus,
    status_summary: uniqueValues_(parts).join(' · '),
    refund_status: refundStatus,
    cancelled_at: cancelledAt,
    closed_at: closedAt
  };
}

function prettyStatus_(value) {
  if (!value) return '';
  return String(value).toLowerCase().split('_').map(function(part) {
    return part ? part.charAt(0).toUpperCase() + part.slice(1) : '';
  }).join(' ');
}

function getProductTagAudit_(tags) {
  var list = normalizeTags_(tags).map(function(t){ return t.toLowerCase(); });
  var found = [];
  PRODUCT_AUDIT_TAGS.forEach(function(flag) {
    if (list.indexOf(flag.toLowerCase()) >= 0) found.push(flag);
  });
  return {
    is_flagged: found.length > 0,
    status: found.length ? found.join(', ') : 'Regular / No dropship tag'
  };
}

// ── Shopify GraphQL fetcher ──────────────────────────────────────────────────

function fetchGraphQLOrders_(shopifyQuery) {
  var all = [];
  var warnings = [];
  var cursor = null;

  var gql = `
    query HitsHudsonOrders($cursor: String, $q: String!, $first: Int!, $lineFirst: Int!) {
      orders(first: $first, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            tags
            createdAt
            sourceName
            app { name }
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            closed
            closedAt
            email
            physicalLocation { id name }
            fulfillments(first: 20) {
              location { id name }
            }
            customer { firstName lastName email }
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } }
            netPaymentSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            refunds {
              id
              refundLineItems(first: 100) {
                edges {
                  node {
                    quantity
                    subtotalSet { shopMoney { amount currencyCode } }
                    totalTaxSet { shopMoney { amount currencyCode } }
                    lineItem { id title sku }
                  }
                }
              }
            }
            lineItems(first: $lineFirst) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  title
                  quantity
                  sku
                  variantTitle
                  originalTotalSet { shopMoney { amount currencyCode } }
                  discountedTotalSet { shopMoney { amount currencyCode } }
                  totalDiscountSet { shopMoney { amount currencyCode } }
                  product { id title tags }
                  variant { id sku inventoryItem { id unitCost { amount currencyCode } } }
                }
              }
            }
          }
        }
      }
    }`;

  do {
    var result = shopifyGraphQL_(gql, {
      cursor: cursor,
      q: shopifyQuery,
      first: GRAPHQL_ORDER_PAGE_SIZE,
      lineFirst: GRAPHQL_LINE_PAGE_SIZE
    });

    if (result.error) return result;
    var ordersConnection = result.data && result.data.orders;
    if (!ordersConnection) return { error: 'GraphQL response did not include orders.' };

    var nodes = getEdgesNodes_(ordersConnection);
    nodes.forEach(function(o) {
      if (o.lineItems && o.lineItems.pageInfo && o.lineItems.pageInfo.hasNextPage) {
        warnings.push('Order ' + (o.name || o.id) + ' has more than ' + GRAPHQL_LINE_PAGE_SIZE + ' line items. Only first page is shown.');
      }
      all.push(o);
    });

    cursor = ordersConnection.pageInfo && ordersConnection.pageInfo.hasNextPage
      ? ordersConnection.pageInfo.endCursor
      : null;
  } while (cursor);

  return { orders: all, warnings: warnings };
}

function shopifyGraphQL_(query, variables) {
  var url = 'https://' + STORE + '/admin/api/' + API_VERSION + '/graphql.json';
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': TOKEN },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code < 200 || code >= 300) {
    return { error: 'Shopify GraphQL HTTP ' + code + ': ' + text.slice(0, 1000) };
  }

  var body;
  try {
    body = JSON.parse(text);
  } catch(e) {
    return { error: 'Could not parse Shopify GraphQL response: ' + text.slice(0, 500) };
  }

  if (body.errors && body.errors.length) {
    return { error: 'Shopify GraphQL errors: ' + JSON.stringify(body.errors, null, 2) };
  }

  return body;
}

function buildHitsQuery_(startDay, endDay) {
  // Search broadly by date, then filter client-side by physicalLocation or fulfillment location name.
  // This avoids missing POS orders that Shopify Analytics groups under
  // pos_location_name='Corro Trailer 1' but are not returned by Admin search
  // location_id in exactly the same way.
  return [
    'status:any',
    'created_at:>=' + startDay,
    'created_at:<=' + endDay
  ].join(' ');
}



// ── 12-week source / 12-week calculation Project Payback API ─────────────────

function getHitsProjectData(params) {
  params = params || {};
  validateConfig_();

  var goalPack = getProjectGoalsFromSheet_();
  var weeksSource = goalPack.weeks && goalPack.weeks.length
    ? goalPack.weeks
    : buildDefaultProjectWeeks_();

  var startDate = parseLocalDate_(weeksSource[0].startISO) || resolveProjectStartDate_(params.projectStartISO);
  var last = weeksSource[weeksSource.length - 1];
  var endDate = parseLocalDate_(last.endISO) || new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + weeksSource.length * 7 - 1);

  var projectCacheKey = cacheKey_('hitsProject', {
    start: isoDay_(startDate),
    end: isoDay_(endDate),
    weeks: weeksSource.map(function(w){ return [w.week, w.startISO, w.endISO, w.goal]; })
  });
  if (!params.forceFresh) {
    var cachedProject = cacheGetJson_(projectCacheKey);
    if (cachedProject) {
      cachedProject.cache_status = 'Loaded from cache to protect Shopify UrlFetch quota';
      return cachedProject;
    }
  }

  var query = buildHitsQuery_(isoDay_(startDate), isoDay_(endDate));
  var pack = fetchGraphQLOrders_(query);
  if (pack.error) return { error: pack.error };

  var stats = {
    api_mode: 'GraphQL Admin API',
    report: 'HITS Hudson Active Show-Week Payback Report',
    location_id_required: String(HITS_LOCATION_ID),
    location_required: HITS_LOCATION_NAME,
    order_tag_audit: HITS_ORDER_TAG,
    warehouse_filter: HITS_LOCATION_NAME,
    graphql_query: query,
    total_orders_scanned: (pack.orders || []).length,
    matched_orders: 0,
    matched_lines: 0,
    online_orders_skipped: 0,
    unknown_source_orders: 0,
    pos_source_orders: 0,
    location_skipped: 0,
    orders_with_hits_tag: 0,
    tag_only_orders: 0,
    cogs_missing_lines: 0,
    line_items_page_limit: GRAPHQL_LINE_PAGE_SIZE,
    goals_source: goalPack.source,
    goals_loaded: weeksSource.length
  };

  var weeks = weeksSource.map(function(g) {
    var ws = parseLocalDate_(g.startISO);
    var we = parseLocalDate_(g.endISO);
    var w = emptyProjectWeek_(g.week, ws, we);
    w.goal = round2_(g.goal || PROJECT_WEEKLY_GROSS_SALES_BUDGET);
    w.goal_source = goalPack.source;
    w.include_in_calculation = Number(g.week) >= PROJECT_CALC_START_WEEK;
    w.calculation_note = w.include_in_calculation ? 'Included in active show-week calculation unless marked Off Week' : 'Not included in final calculation';
    return w;
  });

  (pack.orders || []).forEach(function(order) {
    if (!qualifiesHitsSource_(order, stats)) return;

    var lineRows = buildLineRows_(order, stats);
    // Include the order summary even if line items are missing/empty so Shopify order totals still reconcile.
    var orderSummary = buildOrderSummary_(order, lineRows);
    var od = new Date(orderSummary.order_date);
    var orderDay = new Date(od.getFullYear(), od.getMonth(), od.getDate());
    var idx = -1;
    for (var i = 0; i < weeks.length; i++) {
      var ws = parseLocalDate_(weeks[i].startISO);
      var we = parseLocalDate_(weeks[i].endISO);
      if (orderDay >= ws && orderDay <= we) { idx = i; break; }
    }
    if (idx < 0) return;

    addOrderToProjectWeek_(weeks[idx], orderSummary);
    stats.matched_orders++;
    stats.matched_lines += lineRows.length;
  });

  var cumulativeBudget = -PROJECT_CAPEX;
  weeks.forEach(function(w) {
    finalizeMoney_(w.actual);
    w.actual.gross_margin = w.actual.net_sales > 0 ? w.actual.gross_profit / w.actual.net_sales : 0;

    var goal = round2_(w.goal || PROJECT_WEEKLY_GROSS_SALES_BUDGET);
    var netBudget = round2_(goal * (1 - PROJECT_DISCOUNTS_RETURNS_RATE));
    var grossProfitBudget = PROJECT_WEEKLY_GROSS_PROFIT_BUDGET;
    var contributionBudget = PROJECT_WEEKLY_CONTRIBUTION_BUDGET;

    w.budget = {
      gross_sales: goal,
      marketing_income: PROJECT_WEEKLY_MARKETING_INCOME_BUDGET,
      discounts_returns_rate: PROJECT_DISCOUNTS_RETURNS_RATE,
      net_sales: netBudget,
      gross_margin: PROJECT_GROSS_MARGIN_TARGET,
      gross_profit: grossProfitBudget,
      opex: PROJECT_WEEKLY_OPEX_BUDGET,
      weekly_contribution: contributionBudget
    };

    if (w.include_in_calculation) {
      cumulativeBudget = round2_(cumulativeBudget + contributionBudget);
    }
    w.cumulative_budget_cash = cumulativeBudget;
    w.cumulative_budget_note = w.include_in_calculation ? 'Included unless marked Off Week in the dashboard' : 'Not included in final calculation';
  });

  var projectResult = {
    ok: true,
    generated: new Date().toLocaleString(),
    cache_status: 'Fresh Shopify load',
    project_start: isoDay_(startDate),
    project_end: isoDay_(endDate),
    period_label: fmtShort_(startDate) + ' – ' + fmtShort_(endDate),
    assumptions: getProjectAssumptions_(goalPack),
    weeks: weeks,
    stats: stats,
    warnings: (pack.warnings || []).concat(goalPack.warnings || [])
  };
  cachePutJson_(projectCacheKey, projectResult, HITS_SHOPIFY_CACHE_SECONDS);
  return projectResult;
}

function getProjectAssumptions_(goalPack) {
  goalPack = goalPack || {};
  return {
    weeks: goalPack.weeks && goalPack.weeks.length ? goalPack.weeks.length : PROJECT_WEEKS,
    calculation_weeks: PROJECT_CALC_WEEKS,
    calculation_start_week: PROJECT_CALC_START_WEEK,
    capex: PROJECT_CAPEX,
    trailer_cost: PROJECT_TRAILER_COST,
    setup_furniture_cost: PROJECT_SETUP_FURNITURE_COST,
    capex_other_costs: PROJECT_OTHER_CAPEX_COSTS,
    weekly_gross_sales_budget: PROJECT_WEEKLY_GROSS_SALES_BUDGET,
    weekly_marketing_income_budget: PROJECT_WEEKLY_MARKETING_INCOME_BUDGET,
    discounts_returns_rate: PROJECT_DISCOUNTS_RETURNS_RATE,
    gross_margin_target: PROJECT_GROSS_MARGIN_TARGET,
    weekly_opex_budget: PROJECT_WEEKLY_OPEX_BUDGET,
    weekly_net_sales_budget: PROJECT_WEEKLY_NET_SALES_BUDGET,
    weekly_gross_profit_budget: PROJECT_WEEKLY_GROSS_PROFIT_BUDGET,
    weekly_contribution_budget: PROJECT_WEEKLY_CONTRIBUTION_BUDGET,
    estimated_payback_weeks: Math.ceil(PROJECT_CAPEX / PROJECT_WEEKLY_CONTRIBUTION_BUDGET),
    goals_source: goalPack.source || 'Default model',
    goals_spreadsheet_id: PROJECT_GOALS_SPREADSHEET_ID,
    goals_spreadsheet_url: PROJECT_GOALS_SPREADSHEET_URL,
    goals_sheet_name: PROJECT_GOALS_SHEET_NAME,
    note: 'Weekly sales goals are loaded from the GOALS Google Sheet. Only 12 formal show weeks are shown. Week 1 counts in the calculation unless it is marked as an Off Week in the dashboard. Off weeks are excluded from goal/payback calculations. Orders are pulled by date and then included when Shopify shows Corro Trailer 1 as physical/fulfillment warehouse location OR when the Shopify order tags include HitsHudson. Shopify supplies actual gross sales, net sales, gross profit, gross margin, discounts, returns and orders.'
  };
}

function emptyProjectWeek_(weekNum, startDate, endDate) {
  return {
    week: weekNum,
    startISO: isoDay_(startDate),
    endISO: isoDay_(endDate),
    label: 'Week ' + weekNum + ' · ' + fmtShort_(startDate) + ' – ' + fmtShort_(endDate),
    goal: PROJECT_WEEKLY_GROSS_SALES_BUDGET,
    include_in_calculation: weekNum >= PROJECT_CALC_START_WEEK,
    calculation_note: weekNum >= PROJECT_CALC_START_WEEK ? 'Included in active show-week calculation unless marked Off Week' : 'Not included in final calculation',
    actual: {
      gross_sales: 0,
      gross_profit: 0,
      discounts: 0,
      returns: 0,
      net_sales: 0,
      shipping_charges: 0,
      taxes: 0,
      total_sales: 0,
      total_orders: 0,
      units: 0,
      cogs: 0,
      gross_margin: 0
    }
  };
}

function addOrderToProjectWeek_(week, orderSummary) {
  addToSummary_(week.actual, orderSummary);
}

function getProjectGoalsFromSheet_() {
  var goalsCacheKey = cacheKey_('projectGoals', { spreadsheet: PROJECT_GOALS_SPREADSHEET_ID, sheet: PROJECT_GOALS_SHEET_NAME });
  var cachedGoals = cacheGetJson_(goalsCacheKey);
  if (cachedGoals && cachedGoals.weeks && cachedGoals.weeks.length) {
    cachedGoals.source = cachedGoals.source + ' · cached';
    return cachedGoals;
  }

  var warnings = [];
  var methodsTried = [];

  // Method 1: Google Sheets service. This does NOT use UrlFetchApp quota.
  try {
    methodsTried.push('SpreadsheetApp.openById');
    var ss = SpreadsheetApp.openById(PROJECT_GOALS_SPREADSHEET_ID);
    var sh = ss.getSheetByName(PROJECT_GOALS_SHEET_NAME) || ss.getSheets()[0];
    var parsed = parseProjectGoalsRows_(sh.getDataRange().getDisplayValues(), sh.getDataRange().getValues(), 'Google Sheet loaded with SpreadsheetApp: ' + ss.getName() + ' / ' + sh.getName(), warnings);
    parsed.methods_tried = methodsTried;
    cachePutJson_(goalsCacheKey, parsed, HITS_GOALS_CACHE_SECONDS);
    return parsed;
  } catch (idErr) {
    warnings.push('SpreadsheetApp.openById failed: ' + (idErr && idErr.message ? idErr.message : idErr));
  }

  // Method 2: Google Sheets service by URL. Also does NOT use UrlFetchApp quota.
  try {
    methodsTried.push('SpreadsheetApp.openByUrl');
    var ss2 = SpreadsheetApp.openByUrl(PROJECT_GOALS_SPREADSHEET_URL);
    var sh2 = ss2.getSheetByName(PROJECT_GOALS_SHEET_NAME) || ss2.getSheets()[0];
    var parsed2 = parseProjectGoalsRows_(sh2.getDataRange().getDisplayValues(), sh2.getDataRange().getValues(), 'Google Sheet loaded with SpreadsheetApp URL: ' + ss2.getName() + ' / ' + sh2.getName(), warnings);
    parsed2.methods_tried = methodsTried;
    cachePutJson_(goalsCacheKey, parsed2, HITS_GOALS_CACHE_SECONDS);
    return parsed2;
  } catch (urlErr) {
    warnings.push('SpreadsheetApp.openByUrl failed: ' + (urlErr && urlErr.message ? urlErr.message : urlErr));
  }

  // IMPORTANT: No CSV UrlFetch fallback here. UrlFetch quota is reserved for Shopify.
  var fallback = {
    weeks: buildDefaultProjectWeeks_(),
    source: 'Default model fallback — GOALS sheet not loaded. CSV UrlFetch fallback disabled to protect Shopify quota.',
    warnings: warnings,
    methods_tried: methodsTried,
    spreadsheet_id: PROJECT_GOALS_SPREADSHEET_ID,
    spreadsheet_url: PROJECT_GOALS_SPREADSHEET_URL
  };
  cachePutJson_(goalsCacheKey, fallback, 300);
  return fallback;
}

function parseProjectGoalsRows_(displayValues, rawValues, source, warnings) {
  warnings = warnings || [];
  if (!displayValues || displayValues.length < 2) throw new Error('Goals sheet has no data rows.');

  var headers = displayValues[0].map(function(h) { return normalizeHeader_(h); });
  var idxStart = findHeaderIndex_(headers, ['initial date','initialdate','start date','startdate']);
  var idxEnd = findHeaderIndex_(headers, ['end date','enddate']);
  var idxWeek = findHeaderIndex_(headers, ['# week','#week','week','week number','weeknumber']);
  var idxGoal = findHeaderIndex_(headers, ['goals','goal','sales goal','salesgoal','weekly goal','weeklygoal']);

  if (idxStart < 0 || idxEnd < 0 || idxWeek < 0 || idxGoal < 0) {
    throw new Error('Expected columns in row 1: INITIAL DATE, END DATE, # WEEK, GOALS. Found: ' + displayValues[0].join(' | '));
  }

  var weeks = [];
  for (var r = 1; r < displayValues.length; r++) {
    var rowD = displayValues[r] || [];
    var rowR = rawValues && rawValues[r] ? rawValues[r] : rowD;
    if (!rowD[idxStart] && !rowD[idxEnd] && !rowD[idxGoal]) continue;

    var start = coerceSheetDate_(rowR[idxStart]) || coerceSheetDate_(rowD[idxStart]);
    var end = coerceSheetDate_(rowR[idxEnd]) || coerceSheetDate_(rowD[idxEnd]);
    var week = parseInt(String(rowD[idxWeek] || rowR[idxWeek] || '').replace(/[^0-9]/g, ''), 10);
    var goal = parseMoney_(rowR[idxGoal]);
    if (!goal) goal = parseMoney_(rowD[idxGoal]);

    if (!start || !end || !week) {
      warnings.push('Skipped GOALS row ' + (r + 1) + ': missing date/week.');
      continue;
    }

    weeks.push({
      week: week,
      startISO: isoDay_(start),
      endISO: isoDay_(end),
      goal: round2_(goal)
    });
  }

  weeks.sort(function(a, b) { return a.week - b.week; });
  if (!weeks.length) throw new Error('No usable weekly goals found.');
  // The current HITS Hudson view loads the visible schedule from the GOALS sheet.
  if (weeks.length > PROJECT_WEEKS) {
    weeks = weeks.slice(0, PROJECT_WEEKS);
    warnings.push('GOALS sheet has more than ' + PROJECT_WEEKS + ' weeks. Report is using the first ' + PROJECT_WEEKS + ' formal show weeks only.');
  }

  return {
    weeks: weeks,
    source: source,
    warnings: warnings,
    spreadsheet_id: PROJECT_GOALS_SPREADSHEET_ID,
    spreadsheet_url: PROJECT_GOALS_SPREADSHEET_URL,
    csv_url: PROJECT_GOALS_CSV_URL,
    first_goal_loaded: weeks[0] ? weeks[0].goal : null,
    week_count_loaded: weeks.length
  };
}

function buildDefaultProjectWeeks_() {
  var start = resolveProjectStartDate_('');
  var out = [];
  for (var i = 0; i < PROJECT_WEEKS; i++) {
    var ws = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7);
    var we = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7 + 6);
    out.push({ week: i + 1, startISO: isoDay_(ws), endISO: isoDay_(we), goal: PROJECT_WEEKLY_GROSS_SALES_BUDGET });
  }
  return out;
}

function parseLocalDate_(iso) {
  if (!iso) return null;
  var p = String(iso).split('-');
  if (p.length !== 3) return null;
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function coerceSheetDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  var s = String(v || '').trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var d = new Date(s);
  if (!isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

function parseMoney_(v) {
  if (typeof v === 'number') return round2_(v);
  var s = String(v || '').replace(/[$,\s]/g, '');
  var n = parseFloat(s || 0);
  return isNaN(n) ? 0 : round2_(n);
}

function normalizeHeader_(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function findHeaderIndex_(headers, names) {
  var normalizedNames = names.map(function(n) { return normalizeHeader_(n); });
  for (var i = 0; i < headers.length; i++) {
    if (normalizedNames.indexOf(headers[i]) >= 0) return i;
  }
  return -1;
}

function resolveProjectStartDate_(projectStartISO) {
  var raw = projectStartISO || PROPS.getProperty('HITS_PROJECT_START_DATE') || PROJECT_DEFAULT_START_DATE;
  if (raw) {
    var parts = String(raw).split('-');
    if (parts.length === 3) return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  // Fallback to the current week Monday only if no valid project start is configured.
  var now = new Date();
  var day = now.getDay();
  var diff = (day === 0) ? 6 : day - 1;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
}


function getGoalContextForRange_(startDay, endDay) {
  var pack = getProjectGoalsFromSheet_();
  var start = parseLocalDate_(startDay);
  var end = parseLocalDate_(endDay);
  var matches = [];

  var isFullMonth = false;
  if (start && end) {
    var monthLast = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    isFullMonth = start.getDate() === 1 && end.getFullYear() === monthLast.getFullYear() && end.getMonth() === monthLast.getMonth() && end.getDate() === monthLast.getDate();
  }

  (pack.weeks || []).forEach(function(w) {
    var ws = parseLocalDate_(w.startISO);
    var we = parseLocalDate_(w.endISO);
    if (!ws || !we || !start || !end) return;

    // Weekly filters should match the exact week from the GOALS Sheet.
    // Monthly filters should sum the goals for weeks whose INITIAL DATE falls
    // in that month, so a week is not double-counted across two months.
    if (isFullMonth) {
      if (ws >= start && ws <= end) matches.push(w);
    } else if (we >= start && ws <= end) {
      matches.push(w);
    }
  });

  var exactWeek = matches.length === 1 && matches[0].startISO === startDay && matches[0].endISO === endDay;
  var calcMatches = exactWeek ? matches : matches.filter(function(w) { return isProjectCalculationWeek_(w); });
  var totalGoal = round2_(calcMatches.reduce(function(sum, w) { return sum + Number(w.goal || 0); }, 0));
  var displayGoal = round2_(matches.reduce(function(sum, w) { return sum + Number(w.goal || 0); }, 0));
  exactWeek = matches.length === 1 && matches[0].startISO === startDay && matches[0].endISO === endDay;
  return {
    source: pack.source,
    warnings: pack.warnings || [],
    type: exactWeek ? 'week' : (isFullMonth ? 'month' : 'period'),
    week: exactWeek ? matches[0].week : '',
    startISO: startDay,
    endISO: endDay,
    goal: totalGoal,
    display_goal: displayGoal,
    calculation_goal: totalGoal,
    calculation_weeks: calcMatches.map(function(w) { return w.week; }),
    note: 'Week 1 counts unless marked as an Off Week. Off weeks are excluded in the dashboard calculations.',
    weeks: matches.map(function(w) {
      return { week: w.week, startISO: w.startISO, endISO: w.endISO, goal: w.goal, include_in_calculation: isProjectCalculationWeek_(w) };
    })
  };
}

function formatMoney0_(n) {
  n = Math.round(Number(n || 0));
  return '$' + n.toLocaleString('en-US');
}

function debugProjectGoalsSheet() {
  return getProjectGoalsFromSheet_();
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function debugHitsHudsonCurrentMonth() {
  var now = new Date();
  return getHitsData({ year: now.getFullYear(), month: now.getMonth() + 1, mode: 'month' });
}

function debugHitsHudsonRawQuery() {
  validateConfig_();
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), 1);
  var end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  var q = buildHitsQuery_(isoDay_(start), isoDay_(end));
  var pack = fetchGraphQLOrders_(q);
  Logger.log(JSON.stringify({ query: q, orders: (pack.orders || []).map(function(o) {
    return {
      order_id: o.name,
      tags: normalizeTags_(o.tags).join(', '),
      sourceName: o.sourceName || '',
      appName: o.app && o.app.name ? o.app.name : '',
      physicalLocation: o.physicalLocation ? o.physicalLocation.name : ''
    };
  }) }, null, 2));
  return pack;
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function getEdgesNodes_(connection) {
  if (!connection || !connection.edges) return [];
  return connection.edges.map(function(e) { return e.node; }).filter(Boolean);
}

function money_(moneySet, fallback) {
  var val = moneyOrNull_(moneySet);
  if (val !== null) return round2_(val);
  return round2_(fallback || 0);
}

function moneyOrNull_(moneySet) {
  try {
    if (moneySet && moneySet.shopMoney && moneySet.shopMoney.amount !== undefined && moneySet.shopMoney.amount !== null) {
      return parseFloat(moneySet.shopMoney.amount || 0);
    }
  } catch(e) {}
  return null;
}

function gqlNumericId_(gid) {
  if (!gid) return '';
  var s = String(gid);
  var m = s.match(/\/(\d+)$/);
  return m ? m[1] : s;
}

function customerName_(customer) {
  if (!customer) return 'N/A';
  var name = ((customer.firstName || '') + ' ' + (customer.lastName || '')).trim();
  return name || 'N/A';
}

function customerEmail_(order) {
  if (order && order.customer && order.customer.email) return order.customer.email;
  return (order && order.email) || '';
}

function isShippingLine_(item) {
  var title = String((item && item.title) || '').toLowerCase();
  return title === 'shipping' || title.indexOf('shipping protection') >= 0;
}

function normalizeTags_(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(function(t){ return String(t).trim(); }).filter(Boolean);
  return String(tags).split(',').map(function(t){ return t.trim(); }).filter(Boolean);
}

function containsCI_(haystack, needle) {
  return String(haystack || '').toLowerCase().indexOf(String(needle || '').toLowerCase()) >= 0;
}

function uniqueValues_(arr) {
  var out = [];
  (arr || []).forEach(function(v) {
    String(v || '').split(',').forEach(function(part) {
      var s = String(part || '').trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    });
  });
  return out;
}

function finalizeMoney_(obj) {
  ['gross_sales','gross_profit','discounts','returns','net_sales','shipping_charges','taxes','total_sales','cogs'].forEach(function(k) {
    obj[k] = round2_(obj[k] || 0);
  });
}

function resolveDateRange_(params) {
  var now = new Date();
  var startDate, endDate, periodLabel;

  if (params.startISO && params.endISO) {
    startDate = new Date(params.startISO + 'T00:00:00');
    // Do not truncate future project weeks. The report must show the full
    // GOALS Sheet week, for example Week 1 = Jun 1-Jun 7, even while the
    // week is still in progress. Shopify will simply return no future orders.
    endDate = new Date(params.endISO + 'T23:59:59');
    periodLabel = params.label || (params.startISO + ' – ' + params.endISO);
  } else if (params.month) {
    var year = params.year || now.getFullYear();
    var month = params.month;
    startDate = new Date(year, month - 1, 1);
    // Do not truncate the selected month. Monthly goal checks need the full
    // month target from the GOALS Sheet, not only month-to-date.
    endDate = new Date(year, month, 0, 23, 59, 59);
    periodLabel = monthName_(month) + ' ' + year;
  } else {
    endDate = now;
    startDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    periodLabel = 'Last 60 days';
  }

  return {
    startDate: startDate,
    endDate: endDate,
    startISO: toShopifyISO_(startDate),
    endISO: toShopifyISO_(endDate),
    startDay: isoDay_(startDate),
    endDay: isoDay_(endDate),
    periodLabel: periodLabel
  };
}

function toShopifyISO_(d) {
  return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

function isoDay_(d) {
  var mm = d.getMonth() + 1;
  var dd = d.getDate();
  return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (dd < 10 ? '0' + dd : dd);
}

function fmtShort_(d) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

function monthName_(m) {
  return ['','January','February','March','April','May','June','July','August','September','October','November','December'][m];
}

function round2_(n) {
  return Math.round((parseFloat(n || 0)) * 100) / 100;
}

function validateConfig_() {
  if (!STORE) throw new Error('Missing Script Property: SHOPIFY_STORE');
  if (!TOKEN) throw new Error('Missing Script Property: SHOPIFY_TOKEN');
  if (!HITS_LOCATION_ID) throw new Error('Missing Script Property: HITS_LOCATION_ID. Create the trailer/storefront location in Shopify, copy its numeric location ID, then add it here.');
}
