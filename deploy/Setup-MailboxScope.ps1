<#
.SYNOPSIS
  Geeft de app van het factuurdashboard toegang tot één mailbox, via Exchange
  RBAC for Applications.

.DESCRIPTION
  Het factuurdashboard leest facturen uit de map Facturen onder Inbox en stuurt
  betaalde facturen door naar de boekhouder. Daarvoor is app-only toegang nodig
  tot precies één mailbox.

  In Entra krijgt de app-registratie daarom GEEN Mail.Read of Mail.Send: dat
  zou toegang tot elke mailbox in de tenant geven. In plaats daarvan wordt de
  toegang hier in Exchange Online geregeld, begrensd op één adres:

    1. een service principal in Exchange die naar de app-registratie wijst;
    2. een management scope die alleen die ene mailbox omvat;
    3. twee roltoewijzingen (Mail.ReadWrite en Mail.Send) binnen die scope.

  Het script is idempotent: wat er al staat, blijft staan. Het maakt alleen aan
  wat ontbreekt, en vraagt eerst om bevestiging.

.PARAMETER AppId
  De Application (client) ID van de app-registratie in Entra.

.PARAMETER ServicePrincipalObjectId
  Het Object ID van de ENTERPRISE APPLICATION (de service principal), niet dat
  van de app-registratie. Je vindt hem in Entra onder
  Enterprise applications > (de app) > Overview > Object ID.
  Dit is de meest gemaakte fout bij deze stap.

.PARAMETER Mailbox
  Het primaire e-mailadres van de mailbox met de map Facturen.

.EXAMPLE
  Connect-ExchangeOnline -UserPrincipalName beheerder@voorbeeld.nl
  .\Setup-MailboxScope.ps1 -AppId 1111... -ServicePrincipalObjectId 2222... -Mailbox facturen@voorbeeld.nl

.NOTES
  Draaien op Windows met de module ExchangeOnlineManagement:
    Install-Module ExchangeOnlineManagement -Scope CurrentUser
  Er is een rol als Exchange-beheerder voor nodig.
  Na afloop kan het tot ongeveer een kwartier duren voordat de rechten werken.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$AppId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$ServicePrincipalObjectId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[^\s'`"@]+@[^\s'`"@]+\.[^\s'`"@]{2,}$")]
  [string]$Mailbox,

  [string]$Naam = 'DeKoningFacturen'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scopeNaam      = "$Naam-Mailbox"
$rollen         = @('Application Mail.ReadWrite', 'Application Mail.Send')

function Schrijf($tekst) { Write-Host $tekst }
function SchrijfOk($tekst) { Write-Host "  [ok]       $tekst" -ForegroundColor Green }
function SchrijfNieuw($tekst) { Write-Host "  [gemaakt]  $tekst" -ForegroundColor Cyan }
function SchrijfLet($tekst) { Write-Host "  [let op]   $tekst" -ForegroundColor Yellow }

# -- verbinding controleren ------------------------------------------------
if (-not (Get-Command Get-ServicePrincipal -ErrorAction SilentlyContinue)) {
  throw "Niet verbonden met Exchange Online. Draai eerst: Connect-ExchangeOnline -UserPrincipalName <beheerder>"
}

# -- laten zien wat er gaat gebeuren --------------------------------------
Schrijf ''
Schrijf 'Dit script gaat het volgende instellen in Exchange Online:'
Schrijf ''
Schrijf "  app (client) ID        : $AppId"
Schrijf "  service principal objId: $ServicePrincipalObjectId"
Schrijf "  mailbox                : $Mailbox"
Schrijf "  management scope       : $scopeNaam"
Schrijf "  rollen                 : $($rollen -join ', ')"
Schrijf ''
Schrijf 'De app krijgt hiermee toegang tot UITSLUITEND deze ene mailbox.'
Schrijf 'Controleer of het object-ID van de Enterprise Application is en niet'
Schrijf 'van de app-registratie; dat zijn twee verschillende waarden.'
Schrijf ''

if (-not $PSCmdlet.ShouldProcess($Mailbox, 'app-only toegang instellen')) {
  Schrijf 'Afgebroken; er is niets gewijzigd.'
  return
}

# -- 1. service principal --------------------------------------------------
Schrijf ''
Schrijf '1. Service principal'
$sp = Get-ServicePrincipal -Identity $AppId -ErrorAction SilentlyContinue
if ($sp) {
  SchrijfOk "bestaat al: $($sp.DisplayName)"
  if ($sp.ServiceId -ne $ServicePrincipalObjectId) {
    SchrijfLet "het opgegeven object-ID ($ServicePrincipalObjectId) wijkt af van het bestaande ($($sp.ServiceId))."
    SchrijfLet 'Controleer welke van de twee de Enterprise Application is voordat je verder gaat.'
  }
} else {
  $sp = New-ServicePrincipal -AppId $AppId -ObjectId $ServicePrincipalObjectId -DisplayName $Naam
  SchrijfNieuw "service principal $Naam"
}

# -- 2. management scope ---------------------------------------------------
Schrijf ''
Schrijf '2. Management scope (begrenzing op één mailbox)'
$filter = "PrimarySmtpAddress -eq '$Mailbox'"
$scope = Get-ManagementScope -Identity $scopeNaam -ErrorAction SilentlyContinue
if ($scope) {
  SchrijfOk "bestaat al: $scopeNaam"
  if ($scope.RecipientFilter -notlike "*$Mailbox*") {
    SchrijfLet "de bestaande scope wijst niet naar $Mailbox maar naar: $($scope.RecipientFilter)"
    SchrijfLet 'Pas hem met de hand aan of gebruik een andere -Naam; dit script wijzigt hem niet.'
  }
} else {
  $scope = New-ManagementScope -Name $scopeNaam -RecipientRestrictionFilter $filter
  SchrijfNieuw "scope $scopeNaam met filter $filter"
}

# -- 3. roltoewijzingen ----------------------------------------------------
Schrijf ''
Schrijf '3. Roltoewijzingen'
foreach ($rol in $rollen) {
  $toewijzingNaam = "$Naam-" + ($rol -replace '[^A-Za-z0-9]', '')
  $bestaand = Get-ManagementRoleAssignment -Identity $toewijzingNaam -ErrorAction SilentlyContinue
  if ($bestaand) {
    SchrijfOk "bestaat al: $toewijzingNaam"
  } else {
    New-ManagementRoleAssignment -Name $toewijzingNaam -App $AppId -Role $rol -CustomResourceScope $scopeNaam | Out-Null
    SchrijfNieuw "$toewijzingNaam ($rol, begrensd op $scopeNaam)"
  }
}

# -- 4. controleren --------------------------------------------------------
Schrijf ''
Schrijf '4. Controle'
try {
  $uitslag = Test-ServicePrincipalAuthorization -Identity $AppId -Resource $Mailbox
  $uitslag | Format-Table -AutoSize

  $gevonden = @($uitslag | Where-Object { $_.InScope -eq $true })
  if ($gevonden.Count -ge $rollen.Count) {
    SchrijfOk "de app mag bij $Mailbox."
  } else {
    SchrijfLet 'Nog niet alle rollen staan als InScope. Dat kan aan de verwerkingstijd liggen;'
    SchrijfLet 'draai dit script over een kwartier nog eens, of controleer met:'
    SchrijfLet "  Test-ServicePrincipalAuthorization -Identity $AppId -Resource $Mailbox"
  }
} catch {
  SchrijfLet "De controle zelf gaf een fout: $($_.Exception.Message)"
  SchrijfLet 'Dat betekent niet per se dat het misging; probeer de controle later opnieuw.'
}

Schrijf ''
Schrijf 'Klaar. Vul daarna op hfd-web01 M365_TENANT_ID, M365_CLIENT_ID,'
Schrijf 'M365_CLIENT_SECRET en M365_MAILBOX in /etc/dekoning/facturen.env in,'
Schrijf 'en gebruik op de instellingenpagina de knop "Verbindingen testen".'
Schrijf ''
