param(
  [string]$HostName = "38.49.209.149",
  [string]$UserName = "root",
  [string]$KeyPath = "C:\tmp\qevor-ssh\qevor_oracle_rsa.pem",
  [int]$Port = 4174
)

$ErrorActionPreference = "Stop"
$remote = "$UserName@$HostName"
$files = @(
  "server.mjs", "package.json", "ecosystem.apex.config.cjs",
  "src", "public", "fixtures", "config"
)

ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=no $remote "mkdir -p /opt/apex-agent"
scp -r -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=no $files "$remote`:/opt/apex-agent/"
ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=no $remote "cd /opt/apex-agent && PORT=$Port pm2 delete apex-agent >/dev/null 2>&1 || true; pm2 start ecosystem.apex.config.cjs --update-env; pm2 save"
Write-Host "APEX deployed at http://$HostName`:$Port (if the VPS firewall permits the port)."
