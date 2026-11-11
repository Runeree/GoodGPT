$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is not available.' }
$output = Join-Path $workspace 'dist'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Xaml.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$references += @('PresentationCore.dll', 'PresentationFramework.dll', 'WindowsBase.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll') | ForEach-Object { '/reference:' + (Join-Path (Join-Path $framework 'WPF') $_) }
$winMetadata = Join-Path $env:WINDIR 'System32\WinMetadata'
$references += @('Windows.Foundation.winmd', 'Windows.Globalization.winmd', 'Windows.Graphics.winmd', 'Windows.Media.winmd', 'Windows.Storage.winmd') | ForEach-Object { '/reference:' + (Join-Path $winMetadata $_) }
$runtimeAssembly = Get-ChildItem -LiteralPath (Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Runtime.WindowsRuntime') -Filter 'System.Runtime.WindowsRuntime.dll' -Recurse | Select-Object -First 1
if ($runtimeAssembly) { $references += '/reference:' + $runtimeAssembly.FullName }
$runtimeFacade = Get-ChildItem -LiteralPath (Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Runtime') -Filter 'System.Runtime.dll' -Recurse | Select-Object -First 1
if ($runtimeFacade) { $references += '/reference:' + $runtimeFacade.FullName }
$sources = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' | ForEach-Object FullName)
$arguments = @('/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/utf8output', ('/out:' + (Join-Path $output 'GoodGPT-Windows.exe')))
$arguments += $references
$icon = Join-Path $workspace 'desktop\resources\GoodGPT.ico'
if (Test-Path -LiteralPath $icon) { $arguments += '/win32icon:' + $icon }
$arguments += '/resource:' + (Join-Path $workspace 'assets\bag.png') + ',GoodGPT.Bag.png'
$arguments += '/resource:' + (Join-Path $workspace 'assets\treats.png') + ',GoodGPT.Treats.png'
$arguments += $sources
& $compiler $arguments
if ($LASTEXITCODE -ne 0) { throw "C# compilation failed with exit code $LASTEXITCODE" }
Write-Output ('Ready: ' + (Join-Path $output 'GoodGPT-Windows.exe'))
