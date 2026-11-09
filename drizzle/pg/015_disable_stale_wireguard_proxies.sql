UPDATE proxies
SET active = false, updated_at = now()
WHERE protocol = 'socks5'
  AND host IN ('127.0.0.1', 'localhost')
  AND port BETWEEN 11080 AND 11999
  AND NOT EXISTS (
    SELECT 1
    FROM wireguard_tunnels
    WHERE wireguard_tunnels.proxy_id = proxies.id
      AND wireguard_tunnels.enabled = true
      AND wireguard_tunnels.runtime_status = 'running'
  );
