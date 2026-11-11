$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distPath = Join-Path $projectPath 'dist'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectPath 'src/manifest.json') | ConvertFrom-Json
$extensionArchive = Join-Path $projectPath ("GoodGPT-" + $manifest.version + ".zip")
[System.IO.Directory]::CreateDirectory($distPath) | Out-Null
Copy-Item -LiteralPath $extensionArchive -Destination (Join-Path $distPath 'GoodGPT-Chrome.zip') -Force

# Only these explicit files enter the public bundle.
$bundleFiles = @(
    @{ Source = 'dist/GoodGPT-Windows.exe'; Target = 'Windows/GoodGPT-Windows.exe' },
    @{ Source = 'desktop/windows/README.md'; Target = 'Windows/README.md' },
    @{ Source = 'dist/GoodGPT-macOS.zip'; Target = 'macOS/GoodGPT-macOS.zip' },
    @{ Source = 'desktop/macos/README.md'; Target = 'macOS/README.md' },
    @{ Source = 'dist/GoodGPT-Chrome.zip'; Target = 'Chrome/GoodGPT-Chrome.zip' },
    @{ Source = 'INSTALL.txt'; Target = 'Chrome/INSTALL.txt' },
    @{ Source = 'README.md'; Target = 'README.md' },
    @{ Source = 'LICENSE'; Target = 'LICENSE.txt' }
)
foreach ($bundleFile in $bundleFiles) {
    $sourcePath = Join-Path $projectPath $bundleFile.Source
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Missing release file: $sourcePath"
    }
}

$bundlePath = Join-Path $distPath 'GoodGPT-All.zip'
$stream = [System.IO.File]::Open($bundlePath, [System.IO.FileMode]::Create)
try {
    $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($bundleFile in $bundleFiles) {
            if ($bundleFile.Target -eq 'README.md') {
                $readmeText = [System.IO.File]::ReadAllText((Join-Path $projectPath 'README.md'))
                $readmeText = [regex]::Replace($readmeText, '<img[^>]*>\r?\n', '')
                $readmeText = $readmeText.Replace('desktop/windows/README.md', 'Windows/README.md')
                $readmeText = $readmeText.Replace('desktop/macos/README.md', 'macOS/README.md')
                $readmeText = $readmeText.Replace('(LICENSE)', '(LICENSE.txt)')
                $readmeText = $readmeText.Replace('(assets/README.md)', '(https://github.com/Runeree/GoodGPT/blob/main/assets/README.md)')
                $readmeEntry = $zip.CreateEntry('README.md')
                $writer = [System.IO.StreamWriter]::new($readmeEntry.Open(), [System.Text.UTF8Encoding]::new($false))
                try { $writer.Write($readmeText) } finally { $writer.Dispose() }
                continue
            }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, (Join-Path $projectPath $bundleFile.Source), $bundleFile.Target,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }

$assetNames = @('GoodGPT-Windows.exe', 'GoodGPT-macOS.zip', 'GoodGPT-Chrome.zip', 'GoodGPT-All.zip')
$checksumLines = foreach ($assetName in $assetNames) {
    $hash = Get-FileHash -LiteralPath (Join-Path $distPath $assetName) -Algorithm SHA256
    $hash.Hash.ToLowerInvariant() + '  ' + $assetName
}
[System.IO.File]::WriteAllText(
    (Join-Path $distPath 'SHA256SUMS.txt'), ($checksumLines -join "`n") + "`n",
    [System.Text.UTF8Encoding]::new($false)
)
Write-Output "Ready: $bundlePath"
Write-Output "Checksums: $(Join-Path $distPath 'SHA256SUMS.txt')"
