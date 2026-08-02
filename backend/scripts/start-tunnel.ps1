param(
  [ValidateSet('ngrok', 'localtunnel')]
  [string]$Provider = 'ngrok',
  [int]$Port = 4000
)

if ($Provider -eq 'ngrok') {
  Write-Host "Starting ngrok for port $Port"
  npx ngrok http $Port
  exit $LASTEXITCODE
}

Write-Host "Starting localtunnel for port $Port"
npx localtunnel --port $Port --local-host localhost
exit $LASTEXITCODE
