export function buildNginxServerBlock(host: string, rootPath: string): string {
  return `server {
  listen 80;
  server_name ${host};
  root ${rootPath};
  location / {
    try_files $uri $uri/ /index.html;
  }
}`;
}

export function buildLocalSiteUrl(port: number, sitePath: string): string {
  const pathNormalized = sitePath.replace(/^\/+/, "");
  return `http://localhost:${port}/${pathNormalized}`;
}
