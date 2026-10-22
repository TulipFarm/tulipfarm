CREATE ROLE tulipfarm LOGIN PASSWORD 'local-tulipfarm';
CREATE DATABASE tulipfarm OWNER tulipfarm;

CREATE ROLE temporal LOGIN PASSWORD 'local-temporal';
CREATE DATABASE temporal OWNER temporal;
CREATE DATABASE temporal_visibility OWNER temporal;
