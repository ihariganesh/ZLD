from __future__ import annotations

import math
import json
import os
import sqlite3
import socket
import smtplib
import subprocess
import threading
from csv import DictWriter
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from io import StringIO
from typing import Any

from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__, template_folder="templates", static_folder="static")
DB_PATH = "database.db"
DISCOVERY_PORT = 5001
FLOW_MISMATCH_TOLERANCE_PERCENT = float(os.environ.get("FLOW_MISMATCH_TOLERANCE_PERCENT", "15"))
AUTHORITY_EMAIL = os.environ.get("AUTHORITY_EMAIL", "zld.monitoring@gmail.com")
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USERNAME = os.environ.get("SMTP_USERNAME", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USERNAME or AUTHORITY_EMAIL)
flow_mismatch_active = False
flow_mismatch_lock = threading.Lock()
SENSOR_FIELDS = {
    "ph": "pH sensor",
    "turbidity": "Turbidity sensor",
    "inlet_flow": "Inlet flow sensor",
    "recovery_flow": "Recovery flow sensor",
    "reject_flow": "Reject flow sensor",
    "water_level": "Ultrasonic level sensor",
}


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def run_discovery_responder() -> None:
    discovery_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    discovery_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    discovery_socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        discovery_socket.bind(("", DISCOVERY_PORT))
        while True:
            message, address = discovery_socket.recvfrom(256)
            if message.decode("utf-8", errors="ignore").strip() == "ZLD_DISCOVER":
                discovery_socket.sendto(b"ZLD_DEVICE|FLASK_SERVER", address)
    except OSError as exc:
        print(f"LAN discovery responder stopped: {exc}")
    finally:
        discovery_socket.close()


def initialize_database() -> None:
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                source TEXT NOT NULL CHECK(source IN ('esp32', 'sample')),
                ph REAL,
                turbidity REAL,
                turbidity_raw_adc INTEGER,
                inlet_flow REAL,
                recovery_flow REAL,
                reject_flow REAL,
                water_level REAL,
                tank_percentage INTEGER,
                pump_status TEXT,
                inlet_total_liters REAL DEFAULT 0,
                recovery_total_liters REAL DEFAULT 0,
                reject_total_liters REAL DEFAULT 0,
                sensor_status TEXT NOT NULL DEFAULT '{}',
                flow_mismatch INTEGER NOT NULL DEFAULT 0,
                flow_mismatch_details TEXT NOT NULL DEFAULT ''
            )
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(sensor_readings)")}
        if "sensor_status" not in columns:
            conn.execute("ALTER TABLE sensor_readings ADD COLUMN sensor_status TEXT NOT NULL DEFAULT '{}'")
        if "turbidity_raw_adc" not in columns:
            conn.execute("ALTER TABLE sensor_readings ADD COLUMN turbidity_raw_adc INTEGER")
        if "flow_mismatch" not in columns:
            conn.execute("ALTER TABLE sensor_readings ADD COLUMN flow_mismatch INTEGER NOT NULL DEFAULT 0")
        if "flow_mismatch_details" not in columns:
            conn.execute("ALTER TABLE sensor_readings ADD COLUMN flow_mismatch_details TEXT NOT NULL DEFAULT ''")
        conn.commit()


def parse_iso_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def seed_sample_data() -> None:
    with get_db_connection() as conn:
        existing = conn.execute("SELECT COUNT(*) AS count FROM sensor_readings").fetchone()
        if existing["count"] > 0:
            return

        now = datetime.now(timezone.utc)
        samples = []
        for i in range(12):
            time_value = now - timedelta(minutes=(11 - i) * 5)
            ph = 7.1 + (i % 4) * 0.1
            turbidity = 2.2 + (i % 5) * 0.4
            inlet_flow = 2.6 + (i % 3) * 0.2
            recovery_flow = 1.7 + (i % 3) * 0.15
            reject_flow = 0.6 + (i % 4) * 0.1
            water_level = 14.5 + (i % 5) * 0.8
            tank_percentage = 60 + (i % 5) * 5
            pump_status = "ON" if i % 2 == 0 else "OFF"
            samples.append(
                (
                    time_value.isoformat(),
                    "sample",
                    ph,
                    turbidity,
                    inlet_flow,
                    recovery_flow,
                    reject_flow,
                    water_level,
                    tank_percentage,
                    pump_status,
                    round((i + 1) * 12.5, 2),
                    round((i + 1) * 8.5, 2),
                    round((i + 1) * 3.7, 2),
                )
            )

        conn.executemany(
            """
            INSERT INTO sensor_readings (
                timestamp, source, ph, turbidity,
                inlet_flow, recovery_flow, reject_flow, water_level,
                tank_percentage, pump_status,
                inlet_total_liters, recovery_total_liters, reject_total_liters
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            samples,
        )
        conn.commit()


def get_latest_source_data(source: str) -> sqlite3.Row | None:
    with get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT * FROM sensor_readings
            WHERE source = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (source,),
        ).fetchone()
        return row


def get_history(source: str, limit: int = 20) -> list[dict[str, Any]]:
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM sensor_readings
            WHERE source = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (source, limit),
        ).fetchall()
    return [dict(row) for row in rows[::-1]]


def valid_float(value: Any, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("Numeric field is invalid")

    if not math.isfinite(number):
        raise ValueError("Numeric field must be finite")
    if minimum is not None and number < minimum:
        raise ValueError(f"Value must be >= {minimum}")
    if maximum is not None and number > maximum:
        raise ValueError(f"Value must be <= {maximum}")
    return number


def validate_payload(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object")

    required_fields = [
        "ph",
        "turbidity",
        "inlet_flow",
        "recovery_flow",
        "reject_flow",
        "water_level",
        "tank_percentage",
        "pump_status",
    ]

    for field in required_fields:
        if field not in data:
            raise ValueError(f"Missing required field: {field}")

    limits = {
        "ph": (0, 14),
        "turbidity": (0, 1000),
        "inlet_flow": (0, 1000),
        "recovery_flow": (0, 1000),
        "reject_flow": (0, 1000),
        "water_level": (0, 500),
        "tank_percentage": (0, 100),
    }
    validated = {}
    for field, (minimum, maximum) in limits.items():
        value = data[field]
        validated[field] = None if value is None else valid_float(value, minimum, maximum)

    sensor_status = data.get("sensor_status", {})
    if not isinstance(sensor_status, dict):
        raise ValueError("sensor_status must be a JSON object")
    validated_status = {}
    for field in SENSOR_FIELDS:
        status = sensor_status.get(field)
        if status is None:
            status = "connected" if validated[field] is not None else "unknown"
        status = str(status).strip().lower()
        if status not in {"connected", "unplugged", "unknown", "not_configured", "not_installed"}:
            raise ValueError(
                f"sensor_status.{field} must be 'connected', 'unplugged', "
                "'unknown', 'not_configured', or 'not_installed'"
            )
        validated_status[field] = status
    validated["sensor_status"] = validated_status

    pump_status = str(data["pump_status"]).strip().upper()
    if pump_status not in {"ON", "OFF"}:
        raise ValueError("pump_status must be 'ON' or 'OFF'")
    validated["pump_status"] = pump_status

    for key in ["inlet_total_liters", "recovery_total_liters", "reject_total_liters"]:
        if key in data:
            validated[key] = valid_float(data[key], 0, 1000000)

    if "turbidity_raw_adc" in data and data["turbidity_raw_adc"] is not None:
        validated["turbidity_raw_adc"] = int(
            valid_float(data["turbidity_raw_adc"], 0, 1023)
        )
    else:
        validated["turbidity_raw_adc"] = None

    return validated


def calculate_flow_totals(present: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    previous = get_latest_source_data("esp32")

    if previous is None:
        totals = {
            "inlet_total_liters": 0.0,
            "recovery_total_liters": 0.0,
            "reject_total_liters": 0.0,
        }
        return totals


    previous_time = parse_iso_time(previous["timestamp"])
    elapsed_minutes = max((now - previous_time).total_seconds() / 60.0, 0)

    previous_totals = {
        "inlet_total_liters": float(previous["inlet_total_liters"] or 0),
        "recovery_total_liters": float(previous["recovery_total_liters"] or 0),
        "reject_total_liters": float(previous["reject_total_liters"] or 0),
    }

    totals = {
        "inlet_total_liters": round(previous_totals["inlet_total_liters"] + (present["inlet_flow"] or 0) * elapsed_minutes, 2),
        "recovery_total_liters": round(previous_totals["recovery_total_liters"] + (present["recovery_flow"] or 0) * elapsed_minutes, 2),
        "reject_total_liters": round(previous_totals["reject_total_liters"] + (present["reject_flow"] or 0) * elapsed_minutes, 2),
    }

    return totals


def detect_flow_mismatch(inlet_flow: float | None, recovery_flow: float | None) -> tuple[bool, str]:
    if inlet_flow is None or recovery_flow is None:
        return False, "Waiting for both inlet and recovery flow readings"
    maximum = max(inlet_flow, recovery_flow)
    if maximum <= 0:
        return False, ""
    difference = abs(inlet_flow - recovery_flow)
    percentage = difference / maximum * 100
    if percentage <= FLOW_MISMATCH_TOLERANCE_PERCENT:
        return False, ""
    return True, (
        f"Inlet {inlet_flow:.2f} L/min vs recovery {recovery_flow:.2f} L/min "
        f"({difference:.2f} L/min, {percentage:.1f}% difference; "
        f"limit {FLOW_MISMATCH_TOLERANCE_PERCENT:.1f}%)"
    )


def send_flow_mismatch_email(timestamp: str, details: str) -> None:
    if os.environ.get("EMAIL_DELIVERY", "smtp").lower() == "outlook":
        send_outlook_email(timestamp, details)
        return
    if not SMTP_HOST:
        print("Flow mismatch email not sent: SMTP_HOST is not configured")
        return
    if not SMTP_USERNAME or not SMTP_PASSWORD:
        print("Flow mismatch email not sent: SMTP_USERNAME/SMTP_PASSWORD is not configured")
        return

    message = EmailMessage()
    message["Subject"] = "ZLD alert: flow sensor mismatch"
    message["From"] = SMTP_FROM
    message["To"] = AUTHORITY_EMAIL
    message.set_content(
        "A flow sensor mismatch was detected in the ZLD monitoring system.\n\n"
        f"Time (UTC): {timestamp}\n"
        f"Details: {details}\n\n"
        "The reading is also available in the dashboard history and CSV export."
    )
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
            smtp.starttls()
            smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(message)
        print(f"Flow mismatch email sent to {AUTHORITY_EMAIL}")
    except (OSError, smtplib.SMTPException) as exc:
        print(f"Flow mismatch email failed: {exc}")


def send_outlook_email(timestamp: str, details: str) -> None:
    recipient = AUTHORITY_EMAIL
    subject = "ZLD alert: flow sensor mismatch"
    body = (
        "A flow sensor mismatch was detected in the ZLD monitoring system.\n\n"
        f"Time (UTC): {timestamp}\n"
        f"Details: {details}\n\n"
        "The reading is also available in the dashboard history and CSV export."
    )
    script = (
        "$outlook = New-Object -ComObject Outlook.Application; "
        "$mail = $outlook.CreateItem(0); "
        "$mail.To = $env:ZLD_EMAIL_TO; "
        "$mail.Subject = $env:ZLD_EMAIL_SUBJECT; "
        "$mail.Body = $env:ZLD_EMAIL_BODY; "
        "$mail.Send(); "
        "Write-Output 'Outlook email sent'"
    )
    environment = os.environ.copy()
    environment.update(
        {
            "ZLD_EMAIL_TO": recipient,
            "ZLD_EMAIL_SUBJECT": subject,
            "ZLD_EMAIL_BODY": body,
        }
    )
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Outlook email failed to start: {exc}")
        return
    if result.returncode == 0:
        print(f"Outlook flow mismatch email sent to {recipient}")
    else:
        error = result.stderr.strip() or "Outlook returned a non-zero exit code"
        print(f"Outlook email failed: {error}")


def send_test_email() -> None:
    if not SMTP_USERNAME or not SMTP_PASSWORD:
        raise ValueError("SMTP_USERNAME and SMTP_PASSWORD must be configured")
    if not SMTP_FROM:
        raise ValueError("SMTP_FROM must be configured")
    if not AUTHORITY_EMAIL:
        raise ValueError("AUTHORITY_EMAIL must be configured")

    message = EmailMessage()
    message["Subject"] = "ZLD Project - Test Email Notification"
    message["From"] = SMTP_FROM
    message["To"] = AUTHORITY_EMAIL
    message.set_content(
        "Dear Authority,\n\n"
        "This is a sample test email from the ZLD Water Monitoring System.\n\n"
        "The email notification system is currently being tested.\n\n"
        "System: Zero Liquid Discharge (ZLD)\n"
        "Notification Type: Test Email\n"
        "Status: SMTP Email Test\n\n"
        "No actual water-level or flow-sensor mismatch is being reported.\n\n"
        "Regards,\n"
        "ZLD Water Monitoring System\n"
    )

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        app.logger.error("Test email SMTP authentication failed: %s", exc)
        raise RuntimeError("SMTP authentication failed; check the Gmail App Password") from exc
    except smtplib.SMTPRecipientsRefused as exc:
        app.logger.error("Test email recipient was refused: %s", exc)
        raise RuntimeError("SMTP server refused the recipient address") from exc
    except smtplib.SMTPConnectError as exc:
        app.logger.error("Test email SMTP connection failed: %s", exc)
        raise RuntimeError("Could not connect to the SMTP server") from exc
    except (TimeoutError, OSError, smtplib.SMTPException) as exc:
        app.logger.error("Test email sending failed: %s", exc)
        raise RuntimeError(f"SMTP sending failed: {exc}") from exc


def process_flow_mismatch(timestamp: str, mismatch: bool, details: str) -> None:
    global flow_mismatch_active
    with flow_mismatch_lock:
        should_notify = mismatch and not flow_mismatch_active
        flow_mismatch_active = mismatch
    if should_notify:
        threading.Thread(
            target=send_flow_mismatch_email,
            args=(timestamp, details),
            daemon=True,
        ).start()


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/sensor-status")
def sensor_status():
    return render_template("sensor_status.html")


@app.route("/api/test-email", methods=["POST"])
def test_email():
    if request.remote_addr not in {"127.0.0.1", "::1", "localhost"}:
        app.logger.warning("Rejected test email request from %s", request.remote_addr)
        return jsonify({"status": "error", "message": "Test email is available only locally"}), 403

    try:
        send_test_email()
    except ValueError as exc:
        app.logger.error("Test email configuration error: %s", exc)
        return jsonify({"status": "error", "message": str(exc)}), 500
    except RuntimeError as exc:
        return jsonify({"status": "error", "message": str(exc)}), 502

    return jsonify(
        {
            "status": "success",
            "message": "Test email accepted by SMTP server",
            "recipient": AUTHORITY_EMAIL,
        }
    )


@app.route("/api/sensor-data", methods=["POST"])
def receive_sensor_data():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "Request body must be valid JSON"}), 400

    try:
        validated = validate_payload(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    totals = calculate_flow_totals(validated)
    validated.update(totals)
    validated["source"] = "esp32"
    validated["timestamp"] = datetime.now(timezone.utc).isoformat()
    mismatch, mismatch_details = detect_flow_mismatch(
        validated["inlet_flow"], validated["recovery_flow"]
    )
    validated["flow_mismatch"] = mismatch
    validated["flow_mismatch_details"] = mismatch_details
    process_flow_mismatch(validated["timestamp"], mismatch, mismatch_details)

    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO sensor_readings (
                timestamp, source, ph, turbidity,
                turbidity_raw_adc,
                inlet_flow, recovery_flow, reject_flow, water_level,
                tank_percentage, pump_status,
                inlet_total_liters, recovery_total_liters, reject_total_liters
                , sensor_status, flow_mismatch, flow_mismatch_details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                validated["timestamp"],
                validated["source"],
                validated["ph"],
                validated["turbidity"],
                validated["turbidity_raw_adc"],
                validated["inlet_flow"],
                validated["recovery_flow"],
                validated["reject_flow"],
                validated["water_level"],
                int(round(validated["tank_percentage"])) if validated["tank_percentage"] is not None else None,
                validated["pump_status"],
                validated["inlet_total_liters"],
                validated["recovery_total_liters"],
                validated["reject_total_liters"],
                json.dumps(validated["sensor_status"]),
                int(validated["flow_mismatch"]),
                validated["flow_mismatch_details"],
            ),
        )
        conn.commit()

    return jsonify({"status": "ok", "message": "Sensor data saved successfully"})


@app.route("/api/latest")
def latest_readings():
    esp32_data = get_latest_source_data("esp32")
    source = "esp32" if esp32_data is not None else "sample"
    row = esp32_data if esp32_data is not None else get_latest_source_data("sample")

    if row is None:
        return jsonify({"error": "No data available"}), 404

    payload = {key: row[key] for key in row.keys()}
    payload["source"] = source
    payload["timestamp"] = row["timestamp"]
    payload["pump_status"] = row["pump_status"] or "OFF"
    payload["sensor_status"] = json.loads(row["sensor_status"] or "{}")
    if source == "sample":
        payload["sensor_status"]["ph"] = "unplugged"
        payload["sensor_status"]["turbidity"] = "connected"
    for field in SENSOR_FIELDS:
        if field not in payload["sensor_status"]:
            payload["sensor_status"][field] = "connected" if payload[field] is not None else "unknown"
    payload.pop("temperature", None)
    payload["status"] = "online" if source == "esp32" else "sample"
    payload["flow_mismatch"] = bool(payload.get("flow_mismatch"))
    payload["flow_mismatch_details"] = payload.get("flow_mismatch_details", "")

    # Calculate recovery rate and mass balance
    inlet = payload.get("inlet_flow")
    recovery = payload.get("recovery_flow")
    reject = payload.get("reject_flow")
    if inlet and recovery and float(inlet) > 0:
        payload["recovery_rate"] = round((float(recovery) / float(inlet)) * 100, 1)
    else:
        payload["recovery_rate"] = 0.0

    if inlet is not None and recovery is not None and reject is not None:
        payload["mass_balance_error"] = round(abs(float(inlet) - (float(recovery) + float(reject))), 2)
    else:
        payload["mass_balance_error"] = 0.0

    if payload.get("turbidity_raw_adc") is None and payload.get("turbidity") is not None:
        payload["turbidity_raw_adc"] = int(float(payload["turbidity"]) * 115)

    payload["thresholds"] = {
        "ph_min": 6.5,
        "ph_max": 8.5,
        "ph_critical_low": 5.5,
        "ph_critical_high": 9.5,
        "turbidity_warning_adc": 500,
        "turbidity_critical_adc": 800,
        "tank_low_percent": 20,
        "tank_high_percent": 90,
        "flow_tolerance_percent": FLOW_MISMATCH_TOLERANCE_PERCENT,
    }
    return jsonify(payload)


@app.route("/api/simulate-preset", methods=["POST"])
def simulate_preset():
    data = request.get_json(silent=True) or {}
    preset = data.get("preset", "normal")

    presets = {
        "normal": {
            "ph": 7.38,
            "turbidity": 2.4,
            "turbidity_raw_adc": 265,
            "inlet_flow": 4.00,
            "recovery_flow": 3.60,
            "reject_flow": 0.40,
            "water_level": 14.2,
            "tank_percentage": 72,
            "pump_status": "ON",
            "sensor_status": {k: "connected" for k in SENSOR_FIELDS},
        },
        "mismatch": {
            "ph": 7.30,
            "turbidity": 2.9,
            "turbidity_raw_adc": 320,
            "inlet_flow": 5.50,
            "recovery_flow": 2.10,
            "reject_flow": 0.85,
            "water_level": 16.8,
            "tank_percentage": 64,
            "pump_status": "ON",
            "sensor_status": {k: "connected" for k in SENSOR_FIELDS},
        },
        "high_turbidity": {
            "ph": 8.15,
            "turbidity": 8.8,
            "turbidity_raw_adc": 895,
            "inlet_flow": 3.80,
            "recovery_flow": 2.90,
            "reject_flow": 0.90,
            "water_level": 15.0,
            "tank_percentage": 58,
            "pump_status": "ON",
            "sensor_status": {k: "connected" for k in SENSOR_FIELDS},
        },
        "acidic_ph": {
            "ph": 5.15,
            "turbidity": 3.2,
            "turbidity_raw_adc": 340,
            "inlet_flow": 3.90,
            "recovery_flow": 3.20,
            "reject_flow": 0.70,
            "water_level": 13.8,
            "tank_percentage": 60,
            "pump_status": "ON",
            "sensor_status": {k: "connected" for k in SENSOR_FIELDS},
        },
        "pump_off": {
            "ph": 7.20,
            "turbidity": 1.8,
            "turbidity_raw_adc": 205,
            "inlet_flow": 0.0,
            "recovery_flow": 0.0,
            "reject_flow": 0.0,
            "water_level": 19.5,
            "tank_percentage": 88,
            "pump_status": "OFF",
            "sensor_status": {k: "connected" for k in SENSOR_FIELDS},
        },
        "unplug_ph": {
            "ph": None,
            "turbidity": 2.6,
            "turbidity_raw_adc": 290,
            "inlet_flow": 4.00,
            "recovery_flow": 3.30,
            "reject_flow": 0.70,
            "water_level": 14.0,
            "tank_percentage": 70,
            "pump_status": "ON",
            "sensor_status": {**{k: "connected" for k in SENSOR_FIELDS}, "ph": "unplugged"},
        },
    }

    sim_data = presets.get(preset, presets["normal"])
    validated = validate_payload(sim_data)
    totals = calculate_flow_totals(validated)
    validated.update(totals)
    validated["source"] = "esp32"
    validated["timestamp"] = datetime.now(timezone.utc).isoformat()
    mismatch, mismatch_details = detect_flow_mismatch(
        validated["inlet_flow"], validated["recovery_flow"]
    )
    validated["flow_mismatch"] = mismatch
    validated["flow_mismatch_details"] = mismatch_details
    process_flow_mismatch(validated["timestamp"], mismatch, mismatch_details)

    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO sensor_readings (
                timestamp, source, ph, turbidity,
                turbidity_raw_adc,
                inlet_flow, recovery_flow, reject_flow, water_level,
                tank_percentage, pump_status,
                inlet_total_liters, recovery_total_liters, reject_total_liters
                , sensor_status, flow_mismatch, flow_mismatch_details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                validated["timestamp"],
                validated["source"],
                validated["ph"],
                validated["turbidity"],
                validated["turbidity_raw_adc"],
                validated["inlet_flow"],
                validated["recovery_flow"],
                validated["reject_flow"],
                validated["water_level"],
                int(round(validated["tank_percentage"])) if validated["tank_percentage"] is not None else None,
                validated["pump_status"],
                validated["inlet_total_liters"],
                validated["recovery_total_liters"],
                validated["reject_total_liters"],
                json.dumps(validated["sensor_status"]),
                int(validated["flow_mismatch"]),
                validated["flow_mismatch_details"],
            ),
        )
        conn.commit()

    return jsonify({"status": "ok", "preset": preset, "data": validated})


@app.route("/api/discover")
def discover_devices():
    devices = []
    discovery_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    discovery_socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    discovery_socket.settimeout(1.5)

    try:
        discovery_socket.bind(("", 0))
        discovery_socket.sendto(b"ZLD_DISCOVER", ("255.255.255.255", DISCOVERY_PORT))
        while True:
            try:
                message, address = discovery_socket.recvfrom(256)
            except socket.timeout:
                break

            if message.decode("utf-8", errors="ignore").startswith("ZLD_DEVICE|"):
                parts = message.decode("utf-8", errors="ignore").split("|")
                devices.append(
                    {
                        "device": parts[1] if len(parts) > 1 else "ESP",
                        "ip": address[0],
                    }
                )
    except OSError as exc:
        return jsonify({"error": f"LAN discovery failed: {exc}"}), 503
    finally:
        discovery_socket.close()

    return jsonify({"devices": devices})


@app.route("/api/history")
def history():
    esp32_rows = get_history("esp32", 25)
    rows = esp32_rows if esp32_rows else get_history("sample", 25)
    if not rows:
        return jsonify({"data": []})

    normalized = []
    for row in rows:
        normalized.append(
            {
                "timestamp": row["timestamp"],
                "source": row["source"],
                "ph": row["ph"],
                "turbidity": row["turbidity"],
                "turbidity_raw_adc": row["turbidity_raw_adc"],
                "inlet_flow": row["inlet_flow"],
                "recovery_flow": row["recovery_flow"],
                "reject_flow": row["reject_flow"],
                "water_level": row["water_level"],
                "tank_percentage": row["tank_percentage"],
                "pump_status": row["pump_status"],
                "inlet_total_liters": row["inlet_total_liters"],
                "recovery_total_liters": row["recovery_total_liters"],
                "reject_total_liters": row["reject_total_liters"],
                "sensor_status": json.loads(row["sensor_status"] or "{}"),
                "flow_mismatch": bool(row["flow_mismatch"]),
                "flow_mismatch_details": row["flow_mismatch_details"] or "",
            }
        )
    return jsonify({"data": normalized})


@app.route("/api/export.csv")
def export_csv():
    rows = get_history("esp32", 1000)
    if not rows:
        rows = get_history("sample", 1000)
    output = StringIO()
    fields = [
        "timestamp", "source", "ph", "turbidity_raw_adc", "inlet_flow",
        "recovery_flow", "reject_flow", "water_level", "tank_percentage",
        "pump_status", "inlet_total_liters", "recovery_total_liters",
        "reject_total_liters", "flow_mismatch", "flow_mismatch_details",
    ]
    writer = DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        record = dict(row)
        record["flow_mismatch"] = "Yes" if record.get("flow_mismatch") else "No"
        writer.writerow({field: record.get(field, "") for field in fields})
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=zld-sensor-history.csv"},
    )


initialize_database()
seed_sample_data()


if __name__ == "__main__":
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=run_discovery_responder, daemon=True).start()
    app.run(host="0.0.0.0", port=5000, debug=True)
