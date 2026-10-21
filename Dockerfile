FROM nginxinc/nginx-unprivileged:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css PROTOCOL.md LICENSE /usr/share/nginx/html/
COPY src/ /usr/share/nginx/html/src/

EXPOSE 8080
