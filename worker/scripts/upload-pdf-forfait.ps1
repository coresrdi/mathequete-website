# ─────────────────────────────────────────────────────────────────────────────
# Upload-PdfForfait.ps1
#
# Utilisation (depuis ton poste local Windows) :
#   1. Generer le PDF localement (genere-pdf-local.mjs ou Godot) -> codes-qr.pdf
#   2. Lancer :  .\upload-pdf-forfait.ps1 -ForfaitId 12 -PdfPath .\codes-qr.pdf
#
# Le script lit le token admin dans la variable d'environnement
# MATHEQUETE_ADMIN_TOKEN. Pose-la une fois pour toutes :
#   setx MATHEQUETE_ADMIN_TOKEN "ton-token-secret-ici"
# puis reouvre un terminal.
#
# Documentation D8 : plan_pont_prof_jeu.md
# ─────────────────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [int]$ForfaitId,

    [Parameter(Mandatory=$true)]
    [string]$PdfPath,

    [string]$ApiBase = "https://mathequete-api.coresrdi.workers.dev",

    [switch]$NoEmail        # Si present, le worker n'envoie PAS d'email a l'admin
)

# 1. Verifications prealables
if (-not (Test-Path -LiteralPath $PdfPath)) {
    Write-Error "PDF introuvable : $PdfPath"
    exit 1
}

$token = $env:MATHEQUETE_ADMIN_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "Variable MATHEQUETE_ADMIN_TOKEN non definie. Pose-la avec setx."
    exit 1
}

$fileInfo = Get-Item -LiteralPath $PdfPath
Write-Host ""
Write-Host "[Upload PDF forfait]" -ForegroundColor Cyan
Write-Host "  Forfait ID : $ForfaitId"
Write-Host "  PDF        : $($fileInfo.FullName)"
Write-Host "  Taille     : $([math]::Round($fileInfo.Length / 1024, 1)) Ko"
Write-Host "  API        : $ApiBase"
Write-Host ""

# 2. Recupere l'etat du forfait (verifie token + existence)
$headers = @{ "X-Admin-Token" = $token }
$urlInfo = "$ApiBase/api/admin/forfaits/$ForfaitId"
try {
    $info = Invoke-RestMethod -Method Get -Uri $urlInfo -Headers $headers -ErrorAction Stop
}
catch {
    Write-Error "Echec verification forfait : $($_.Exception.Message)"
    exit 2
}

Write-Host "Forfait verifie :" -ForegroundColor Green
Write-Host "  Ecole       : $($info.forfait.ecole_nom)"
Write-Host "  Code court  : $($info.forfait.code_court)"
Write-Host "  Tier        : $($info.forfait.tier_nom)"
Write-Host "  Nb codes QR : $($info.forfait.nb_licences_total)"
Write-Host "  Statut PDF  : $($info.forfait.pdf_statut)"
Write-Host ""

$confirm = Read-Host "Continuer l'upload ? (o/N)"
if ($confirm -ne 'o' -and $confirm -ne 'O') {
    Write-Host "Annule." -ForegroundColor Yellow
    exit 0
}

# 3. Upload du PDF en PUT binary
$urlPut = "$ApiBase/api/admin/forfaits/$ForfaitId/pdf"
if ($NoEmail) { $urlPut += "?notifier=0" }

Write-Host ""
Write-Host "Upload en cours..." -ForegroundColor Cyan

try {
    $pdfBytes = [System.IO.File]::ReadAllBytes($fileInfo.FullName)
    $result = Invoke-RestMethod `
        -Method Put `
        -Uri $urlPut `
        -Headers @{ "X-Admin-Token" = $token } `
        -ContentType "application/pdf" `
        -Body $pdfBytes `
        -ErrorAction Stop
}
catch {
    Write-Error "Echec upload : $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) {
        Write-Error "Reponse serveur : $($_.ErrorDetails.Message)"
    }
    exit 3
}

Write-Host ""
Write-Host "Upload reussi !" -ForegroundColor Green
Write-Host "  Chemin R2     : $($result.chemin_r2)"
Write-Host "  Octets uploads: $($result.octets)"
Write-Host "  Statut        : $($result.pdf_statut)"
Write-Host "  Email envoye  : $($result.email_envoye)"
if ($result.url_pdf) {
    Write-Host ""
    Write-Host "Lien admin (valide 30j) :" -ForegroundColor Cyan
    Write-Host "  $($result.url_pdf)"
}
Write-Host ""
