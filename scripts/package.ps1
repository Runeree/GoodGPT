$ErrorActionPreference = 'Stop'
$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $project 'extension'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $runtime 'manifest.json') | ConvertFrom-Json
$archive = Join-Path $project ("GoodGPT-" + $manifest.version + ".zip")
Compress-Archive -Path (Join-Path $runtime '*') -DestinationPath $archive -Force
Write-Output "Ready: $archive"
