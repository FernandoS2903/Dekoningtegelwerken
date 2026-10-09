// De vaste mailinterface van de dienst.
//
// Sorteerder, factuurdashboard en portaal praten alleen via deze interface
// met de mailbox. Welke aanbieder erachter zit, bepaalt MAIL_PROVIDER in de
// env; nu bestaat alleen `m365` (Microsoft Graph, lib/mail/m365.mjs). Een
// Gmail-adapter komt later als lib/mail/gmail.mjs met dezelfde functies,
// zonder dat er elders iets verandert.
//
// Een adapter is een object met:
//
//   provider, beschikbaar, adres         naam, of hij is ingesteld, het mailadres
//
//   Kern (de sorteerder):
//   nieuweBerichten({deltaLink, vanaf})  -> {berichten: [Bericht], deltaLink}
//                                           Zonder deltaLink: alleen een startpunt
//                                           vanaf `vanaf`, niets historisch.
//                                           Een verlopen deltaLink gooit een fout
//                                           met `.verlopen = true`.
//   verplaats(id, mapId)                 -> nieuw id (mapId INBOX = terug naar de Inbox)
//   categorie(id, naam)                  -> voegt een categorie/label toe, bestaande blijven
//   doorsturen(id, {naar, commentaar})   -> stuurt de originele mail door
//   mapAanmaken(naam)                    -> {id, naam, nieuw}; zoekt eerst, maakt alleen aan als hij ontbreekt
//
//   Ondersteunend:
//   mapZoeken(naam)                      -> {id, naam} of null, maakt niets aan
//   inhoud(id, {maxTekens})              -> {tekst, bijlagen: [namen]} voor de classificatie
//   test()                               -> {ok, melding}; test echt op de mailbox
//
//   Factuurdashboard (lezen van de map Facturen; bestaande namen):
//   mapInfo(), mails({vanaf, bekend}), pdfBijlagen(id), mailTekst(id),
//   stuurDoor(id, {...}) en voegCategorieToe(id, naam) (gelijk aan doorsturen/categorie)
//
//   Webhook (optioneel, per aanbieder anders):
//   webhook = {maak({notificatieUrl, clientState, verlooptOp}), verleng(id, verlooptOp), verwijder(id)} of null
//
// Bericht (genormaliseerd, los van de aanbieder):
//   {id, internetId, ontvangen, afzender: {naam, adres}, onderwerp,
//    heeftBijlagen, soort: 'mail' | 'agenda', gemarkeerd, concept,
//    categorieen, verwijderd}

import { maakM365Koppeling } from './m365.mjs';

// Doel voor "terug naar de Inbox"; elke adapter vertaalt dit zelf.
export const INBOX = 'inbox';

export const KERN = ['nieuweBerichten', 'verplaats', 'categorie', 'doorsturen', 'mapAanmaken'];
export const ONDERSTEUNEND = ['mapZoeken', 'inhoud', 'test'];
export const FACTUREN = ['mapInfo', 'mails', 'pdfBijlagen', 'mailTekst', 'stuurDoor', 'voegCategorieToe'];

export const PROVIDERS = ['m365'];

// Gooit als een adapter een functie mist, zodat een halve adapter niet
// pas midden in een sorteerronde opvalt.
export function controleerKoppeling(koppeling) {
  const mist = [...KERN, ...ONDERSTEUNEND, ...FACTUREN].filter((naam) => typeof koppeling[naam] !== 'function');
  if (mist.length) throw new Error(`mailkoppeling ${koppeling.provider || '?'} mist: ${mist.join(', ')}`);
  for (const veld of ['provider', 'beschikbaar', 'adres']) {
    if (!(veld in koppeling)) throw new Error(`mailkoppeling mist het veld ${veld}`);
  }
  return koppeling;
}

export function maakMailKoppeling({ provider = 'm365', ...opties } = {}) {
  const naam = String(provider || 'm365').trim().toLowerCase();
  if (naam === 'm365') return controleerKoppeling(maakM365Koppeling(opties));
  throw new Error(`onbekende MAIL_PROVIDER "${provider}"; mogelijk: ${PROVIDERS.join(', ')}`);
}
