FROM dxflrs/garage:v2.3.0
COPY garage.toml /etc/garage.toml
ENTRYPOINT ["/garage"]
CMD ["-c", "/etc/garage.toml", "server", "--single-node", "--default-bucket"]
