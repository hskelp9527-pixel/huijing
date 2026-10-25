ALTER TABLE runs ADD COLUMN quota_ip TEXT NOT NULL DEFAULT 'local';
ALTER TABLE quota_reservations ADD COLUMN ip_subject TEXT NOT NULL DEFAULT 'local';
ALTER TABLE quota_reservations ADD COLUMN kind TEXT NOT NULL DEFAULT 'image' CHECK(kind IN ('image','text'));
CREATE INDEX quota_reservation_daily ON quota_reservations(day,kind,state,ip_subject,user_id);
