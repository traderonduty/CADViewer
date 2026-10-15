// Parses a DWG/DXF file off the main thread and returns render-ready geometry.
import { LibreDwg, Dwg_File_Type } from './lib/dist/libredwg-web.js';
import { buildModel, transferList } from './dwg-model.js';
import { dxfToDb } from './dxf-adapter.js';

let lib = null;
const say = (stage) => postMessage({ type: 'progress', stage });

self.onmessage = async (ev) => {
  const { buf, name } = ev.data;
  try {
    const bytes = new Uint8Array(buf);
    const head = new TextDecoder().decode(bytes.subarray(0, 6));
    const isDwg = /^AC\d{4}$/.test(head);
    const isDxf = !isDwg && (/\.dxf$/i.test(name) || /^\s*0\s*\r?\n\s*SECTION/.test(new TextDecoder().decode(bytes.subarray(0, 64))));
    if (!isDwg && !isDxf) throw new Error('This file is not a DWG or DXF drawing. Export it from your CAD program as DWG or DXF and try again.');
    if (isDwg && !lib) { say('Starting the DWG reader'); lib = await LibreDwg.create(new URL('./lib/wasm', import.meta.url).href); }
    say('Reading ' + (isDwg ? 'DWG' : 'DXF') + ' data');
    let db;
    if (isDwg) {
      const dwg = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
      if (!dwg) throw new Error('The reader could not decode this file. It may be damaged or saved in a format version it does not support.');
      say('Converting objects');
      db = lib.convert(dwg);
      try { lib.dwg_free(dwg); } catch { /* ignore */ }
    } else {
      const { DxfParser } = await import('./lib/dxf-json.js');
      const text = new TextDecoder().decode(bytes);
      if (/^AutoCAD Binary DXF/.test(text)) throw new Error('Binary DXF files are not supported. Save the drawing as ASCII DXF or as DWG.');
      const parsed = new DxfParser().parseSync(text);
      say('Converting objects');
      db = dxfToDb(parsed);
    }
    say('Building geometry');
    const model = buildModel(db);
    model.meta.fileName = name;
    model.meta.head = isDwg ? head : 'DXF';
    model.meta.bytes = bytes.length;
    postMessage({ type: 'done', model }, transferList(model));
  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
