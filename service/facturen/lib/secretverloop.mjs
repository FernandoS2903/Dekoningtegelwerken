// Vervaldatum van het client secret van de portaal-app in Entra. Die is niet
// via Graph uit te lezen zonder Application.Read.All, dus hij staat in de env
// (ENTRA_PORTAL_CLIENT_SECRET_VERLOOPT=JJJJ-MM-DD, overgenomen uit de
// Entra-portal). Vanaf dertig dagen vooraf komt er dagelijks een waarschuwing
// in het logboek en per mail.

export const WAARSCHUW_DAGEN = 30;

export function dagenTotVerloop(datum, nu = Date.now()) {
  const m = String(datum || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return null;
  return Math.floor((t - nu) / (24 * 3600 * 1000));
}

// Geeft de waarschuwingstekst, of null als er niets te melden is.
export function secretWaarschuwing(datum, nu = Date.now()) {
  if (!String(datum || '').trim()) return 'ENTRA_PORTAL_CLIENT_SECRET_VERLOOPT staat niet in de env; de vervaldatum van het client secret wordt niet bewaakt.';
  const dagen = dagenTotVerloop(datum, nu);
  if (dagen === null) return 'ENTRA_PORTAL_CLIENT_SECRET_VERLOOPT is geen datum (JJJJ-MM-DD); de vervaldatum van het client secret wordt niet bewaakt.';
  if (dagen < 0) return `Het client secret van de portaal-app (Entra) is ${-dagen} dag${dagen === -1 ? '' : 'en'} geleden verlopen (${datum}): inloggen met Microsoft werkt niet meer. Maak in Entra een nieuw secret en zet het in de env.`;
  if (dagen <= WAARSCHUW_DAGEN) return `Het client secret van de portaal-app (Entra) verloopt over ${dagen} dag${dagen === 1 ? '' : 'en'} (${datum}). Maak op tijd een nieuw secret in Entra en zet het in de env.`;
  return null;
}

export function maakSecretControle({ verloopt, log = () => {}, mail = null, naar = '', nu = () => Date.now() }) {
  let laatstGemaild = '';
  return async function controleer() {
    const tekst = secretWaarschuwing(verloopt, nu());
    if (!tekst) return null;
    log('warn', tekst);
    const dag = new Date(nu()).toISOString().slice(0, 10);
    if (mail && mail.beschikbaar && typeof mail.verstuurMail === 'function' && naar && laatstGemaild !== dag && dagenTotVerloop(verloopt, nu()) !== null) {
      try {
        await mail.verstuurMail({ aan: naar, onderwerp: 'Portaal: client secret van de Microsoft-login verloopt', tekst });
        laatstGemaild = dag;
      } catch (fout) {
        log('error', `Waarschuwing over het client secret mailen mislukt: ${fout.message}`);
      }
    }
    return tekst;
  };
}
