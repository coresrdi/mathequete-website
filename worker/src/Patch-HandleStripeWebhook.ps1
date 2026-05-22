$Target = "C:\mathequete\mathequete-website\worker\src\stripe-webhook.ts"
$Backup = "$Target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (-not (Test-Path $Target)) { Write-Error "Fichier introuvable : $Target"; exit 1 }
Copy-Item $Target $Backup
Write-Host "Backup: $Backup" -ForegroundColor Green
$lines = Get-Content $Target -Encoding UTF8
Get-Content $Target -Encoding UTF8 | Where-Object { $_ -match 'tier_id' } | ForEach-Object { Write-Host $_ }
Write-Host "Fichier lu. Lignes ci-dessus contiennent tier_id." -ForegroundColor Yellow
Write-Host "Backup cree. Maintenant colle le bloc TypeScript dans le fichier manuellement."
Write-Host "Backup disponible : $Backup"
