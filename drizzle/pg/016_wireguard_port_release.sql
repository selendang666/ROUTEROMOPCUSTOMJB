DELETE FROM wireguard_tunnels
WHERE proxy_id IS NULL;

ALTER TABLE wireguard_tunnels
  DROP CONSTRAINT IF EXISTS wireguard_tunnels_proxy_id_fkey;

ALTER TABLE wireguard_tunnels
  ADD CONSTRAINT wireguard_tunnels_proxy_id_fkey
  FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE;
