
// CSV parse & stringify with basic quote support
export function parseCSV(text){
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // remove UTF-8 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i=0;i<text.length;i++){
    const ch = text[i];
    if (inQ){
      if (ch === '"'){
        if (text[i+1] === '"'){ cur += '"'; i++; }
        else inQ = false;
      }else cur += ch;
    }else{
      if (ch === '"') inQ = true;
      else if (ch === ","){ row.push(cur); cur=""; }
      else if (ch === "\n"){
        row.push(cur); cur="";
        if (row.length>1 || row[0]!=="" ) rows.push(row);
        row=[];
      }else cur += ch;
    }
  }
  row.push(cur);
  if (row.length>1 || row[0]!=="" ) rows.push(row);
  if (rows.length === 0) return { header:[], data:[] };
  const header = rows[0].map(s=>s.trim());
  const data = rows.slice(1).map(r=>{
    const obj = {};
    for (let i=0;i<header.length;i++){
      obj[header[i]] = (r[i] ?? "").toString();
    }
    return obj;
  });
  return { header, data };
}

function esc(v){
  v = (v ?? "").toString();
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g,'""') + '"';
  return v;
}

export function toCSV(header, rows){
  const lines = [];
  lines.push(header.map(esc).join(","));
  for (const r of rows){
    lines.push(header.map(h=>esc(r[h])).join(","));
  }
  // BOM for Excel
  return "\uFEFF" + lines.join("\n");
}
