// Een kleine lezer voor multipart/form-data (RFC 7578), zonder dependencies,
// voor het aanvraagformulier van de website. De hele body staat al in het
// geheugen (begrensd door de aanroeper); hier wordt hij alleen in delen
// geknipt. Velden komen als tekst terug, bestanden als Buffer met hun
// opgegeven naam en type; of dat type klopt, controleert de aanroeper zelf
// (magic bytes).

export const MAX_DELEN = 200;
export const MAX_VELD_BYTES = 64 * 1024;

export function boundaryUit(contentType) {
  const m = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const b = m[1] || m[2];
  return b && b.length <= 200 ? b : null;
}

function leesKoppen(tekst) {
  const koppen = {};
  for (const regel of tekst.split(/\r\n/)) {
    const i = regel.indexOf(':');
    if (i <= 0) continue;
    koppen[regel.slice(0, i).trim().toLowerCase()] = regel.slice(i + 1).trim();
  }
  return koppen;
}

// Parameters uit een Content-Disposition: name="..." en filename="...".
function dispositie(waarde) {
  const uit = {};
  for (const m of String(waarde || '').matchAll(/;\s*([a-z*]+)=(?:"((?:[^"\\]|\\.)*)"|([^;]*))/gi)) {
    uit[m[1].toLowerCase()] = (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]).trim();
  }
  return uit;
}

// Geeft {velden: Map<naam, string[]>, bestanden: [{veld, naam, type, inhoud}]}.
// Gooit bij een body die geen geldige multipart is.
export function leesMultipart(body, boundary) {
  const velden = new Map();
  const bestanden = [];
  const scheiding = Buffer.from('--' + boundary);
  let pos = body.indexOf(scheiding);
  if (pos === -1) throw new Error('geen boundary in de body');
  pos += scheiding.length;
  let delen = 0;
  while (true) {
    // Na een boundary: "--" (einde) of CRLF (volgend deel).
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (pos >= body.length) break;
    else throw new Error('ongeldige multipart');
    const kopEinde = body.indexOf('\r\n\r\n', pos);
    if (kopEinde === -1) throw new Error('deel zonder koppen');
    const koppen = leesKoppen(body.subarray(pos, kopEinde).toString('utf8'));
    const inhoudStart = kopEinde + 4;
    const volgende = body.indexOf(Buffer.from('\r\n--' + boundary), inhoudStart);
    if (volgende === -1) throw new Error('deel zonder einde');
    const inhoud = body.subarray(inhoudStart, volgende);
    pos = volgende + 2 + scheiding.length;
    if (++delen > MAX_DELEN) throw new Error('te veel delen');

    const d = dispositie(koppen['content-disposition']);
    if (!d.name) continue;
    if (d.filename !== undefined) {
      if (!d.filename || !inhoud.length) continue; // leeg bestandsveld
      bestanden.push({
        veld: d.name,
        naam: d.filename.replace(/[\\/]/g, '_').slice(0, 200),
        type: String(koppen['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase(),
        inhoud: Buffer.from(inhoud), // eigen kopie, los van de body
      });
    } else {
      if (inhoud.length > MAX_VELD_BYTES) throw new Error('veld te groot');
      const lijst = velden.get(d.name) || [];
      lijst.push(inhoud.toString('utf8'));
      velden.set(d.name, lijst);
    }
  }
  return { velden, bestanden };
}

// Het bestandstype uit de eerste bytes; null als het geen jpeg, png, webp of
// pdf is. De naam en het opgegeven type van de browser tellen niet.
export function typeUitInhoud(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export const EXTENSIE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
