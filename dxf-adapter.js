// Converts @mlightcad/dxf-json output into the same shape libredwg-web produces,
// so dwg-model.js can treat DXF and DWG files identically.
const D2R = Math.PI / 180;
const rad = (v) => (typeof v === 'number' ? v * D2R : v);

function fixText(e) {
  if (e.halign === undefined && e.horizontalJustification !== undefined) e.halign = e.horizontalJustification;
  if (e.valign === undefined && e.verticalJustification !== undefined) e.valign = e.verticalJustification;
  if (e.endPoint === undefined && e.alignmentPoint) e.endPoint = e.alignmentPoint;
  e.rotation = rad(e.rotation || 0);
  return e;
}
function fixEntity(e) {
  switch (e.type) {
    case 'LWPOLYLINE': e.flag = ((e.flag || 0) & 1 ? 512 : 0) | ((e.flag || 0) & 128 ? 256 : 0); break;
    case 'ARC': e.startAngle = rad(e.startAngle); e.endAngle = rad(e.endAngle); break;
    case 'INSERT': e.rotation = rad(e.rotation || 0); break;
    case 'TEXT': fixText(e); break;
    case 'MTEXT':
      if (e.textHeight === undefined) e.textHeight = e.height;
      if (!e.direction && e.xAxisDirection) e.direction = e.xAxisDirection;
      if (e.rectWidth === undefined && e.width !== undefined) e.rectWidth = e.width;
      break;
    case 'HATCH':
      for (const p of e.boundaryPaths || []) for (const ed of p.edges || []) {
        if (ed.type === 2 || ed.type === 3) { ed.startAngle = rad(ed.startAngle); ed.endAngle = rad(ed.endAngle); ed.isCCW = ed.isCCW ? 1 : 0; }
      }
      for (const L of e.definitionLines || []) L.angle = rad(L.angle);
      if (e.solidFill === true) e.solidFill = 1;
      break;
    case 'VIEWPORT':
      e.viewportCenter ||= e.center || e.centerPoint;
      e.displayCenter ||= e.viewCenter || e.viewportCenter;
      break;
    case 'DIMENSION':
      if (!e.insertionPoint) e.insertionPoint = { x: 0, y: 0 };
      break;
  }
  if (e.colorIndex === undefined && e.color === undefined) e.colorIndex = 256;
  return e;
}
function attachAttribs(list) {
  const out = []; let last = null;
  for (const e of list || []) {
    if (e.type === 'ATTRIB') {
      if (last) {
        fixText(e);
        (last.attribs ||= []).push({ type: 'ATTRIB', layer: e.layer, colorIndex: e.colorIndex ?? 256, color: e.color, tag: e.tag, flags: e.attributeFlag ?? e.flags ?? 0,
          text: { text: e.text, startPoint: e.startPoint, endPoint: e.endPoint, textHeight: e.textHeight, rotation: e.rotation, xScale: e.xScale ?? 1, halign: e.halign || 0, valign: e.valign || 0, extrusionDirection: e.extrusionDirection } });
      }
      continue;
    }
    if (e.type === 'SEQEND') continue;
    fixEntity(e);
    last = e.type === 'INSERT' ? e : null;
    out.push(e);
  }
  return out;
}

export function dxfToDb(d) {
  const header = {};
  for (const [k, v] of Object.entries(d.header || {})) header[k.replace(/^\$/, '')] = v;
  const tables = {};
  for (const [k, t] of Object.entries(d.tables || {})) tables[k] = { entries: (t.entries || []).map(x => ({ ...x })) };
  for (const L of tables.LAYER?.entries || []) { if (L.frozen === undefined) L.frozen = !!((L.standardFlag || 0) & 1); if (L.off === undefined) L.off = (L.colorIndex ?? 7) < 0; }
  const blocks = d.blocks || {};
  const brs = tables.BLOCK_RECORD?.entries || [];
  for (const br of brs) {
    const b = blocks[br.name];
    br.entities = attachAttribs(b?.entities || []);
    br.basePoint = b?.position || { x: 0, y: 0, z: 0 };
  }
  // blocks without a record (old DXF): add them
  for (const [name, b] of Object.entries(blocks)) if (!brs.some(r => r.name === name)) brs.push({ name, handle: b.handle, entities: attachAttribs(b.entities || []), basePoint: b.position || { x: 0, y: 0 } });
  if (!tables.BLOCK_RECORD) tables.BLOCK_RECORD = { entries: brs };
  const ms = brs.find(b => /^\*model_space$/i.test(b.name));
  const entities = attachAttribs(d.entities || []);
  // R12-style DXF: entities have no owner — keep them all in model space
  for (const e of entities) if (!e.ownerBlockRecordSoftId && ms) e.ownerBlockRecordSoftId = ms.handle;
  const layouts = d.objects?.byName?.LAYOUT || [];
  return { header, tables, entities, objects: { LAYOUT: layouts }, blocks };
}
