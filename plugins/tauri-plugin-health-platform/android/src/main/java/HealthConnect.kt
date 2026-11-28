package com.zuchiangmai.health.platform

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import java.time.Instant
import java.time.ZoneOffset
import kotlin.reflect.KClass
import org.json.JSONArray
import org.json.JSONObject

/**
 * Health Connect for the runtime's sync (health-runtime/src/syshealth.rs): records go out as the core reads them
 * (crates/health-core/src/syshealth.rs `HcRecord`: a kind, a value in the unit named there, times, the record's own
 * offset); nothing here decides what a record means.
 */
class HealthConnect(private val context: Context) {
    val readTypes: List<KClass<out Record>> = listOf(
        HeartRateRecord::class, RestingHeartRateRecord::class, HeartRateVariabilityRmssdRecord::class,
        OxygenSaturationRecord::class, RespiratoryRateRecord::class, BodyTemperatureRecord::class,
        BloodPressureRecord::class, BloodGlucoseRecord::class, Vo2MaxRecord::class, WeightRecord::class,
        HeightRecord::class, BodyFatRecord::class, LeanBodyMassRecord::class, BasalMetabolicRateRecord::class,
        StepsRecord::class, DistanceRecord::class, FloorsClimbedRecord::class, ActiveCaloriesBurnedRecord::class,
        SleepSessionRecord::class,
    )

    /** Lab results written back: body composition (no BMI or waist type here) */
    private val writtenTypes: List<KClass<out Record>> =
        listOf(WeightRecord::class, HeightRecord::class, BodyFatRecord::class, LeanBodyMassRecord::class)

    val available: Boolean get() = HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE
    private val client by lazy { HealthConnectClient.getOrCreate(context) }

    /** Everything this app asks for: reading the types above, writing the body composition, older history */
    fun permissions(): Set<String> =
        readTypes.map { HealthPermission.getReadPermission(it) }.toSet() +
            writtenTypes.map { HealthPermission.getWritePermission(it) } +
            HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY

    private suspend fun historyAllowed(): Boolean =
        client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE &&
            HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in client.permissionController.getGrantedPermissions()

    /** The oldest data it will give: all of it with the history permission, else the 30 days before access */
    suspend fun earliestMs(): Long = if (historyAllowed()) 0 else System.currentTimeMillis() - 30L * 86_400_000

    /** Every page of one type in [from, to), this app's own left out */
    private suspend fun <T : Record> all(type: KClass<T>, from: Instant, to: Instant, mine: Boolean = false): List<T> {
        val out = mutableListOf<T>()
        var token: String? = null
        do {
            val r = client.readRecords(
                ReadRecordsRequest(
                    type,
                    TimeRangeFilter.between(from, to),
                    dataOriginFilter = if (mine) setOf(DataOrigin(context.packageName)) else emptySet(),
                    pageSize = 5000,
                    pageToken = token,
                )
            )
            out += r.records.filter { mine || it.metadata.dataOrigin.packageName != context.packageName }
            token = r.pageToken
        } while (token != null)
        return out
    }

    private fun sample(kind: String, value: Double?, start: Instant, end: Instant?, offset: ZoneOffset?, r: Record): JSONObject {
        val o = JSONObject()
        o.put("store", "health_connect")
        o.put("kind", kind)
        if (value != null) o.put("value", value)
        o.put("start_ms", start.toEpochMilli())
        if (end != null) o.put("end_ms", end.toEpochMilli())
        o.put("tz_min", (offset ?: ZoneOffset.UTC).totalSeconds / 60)
        o.put("origin", r.metadata.dataOrigin.packageName)
        val d = r.metadata.device
        o.put("device", if (d == null) "" else listOfNotNull(d.manufacturer, d.model).joinToString(" "))
        o.put("origin_name", appName(r.metadata.dataOrigin.packageName))
        return o
    }

    private val names = mutableMapOf<String, String>()
    private fun appName(pkg: String): String = names.getOrPut(pkg) {
        try {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (e: Exception) {
            pkg
        }
    }

    /** Records starting in [from, to), one sample each (series and blood pressure split), as the core reads them */
    suspend fun read(fromMs: Long, toMs: Long): JSONArray {
        val from = Instant.ofEpochMilli(fromMs)
        val to = Instant.ofEpochMilli(toMs)
        val inRange = { t: Instant -> !t.isBefore(from) && t.isBefore(to) }
        val out = JSONArray()
        for (r in all(HeartRateRecord::class, from, to)) for (s in r.samples) if (inRange(s.time))
            out.put(sample("HeartRate", s.beatsPerMinute.toDouble(), s.time, null, r.startZoneOffset, r))
        for (r in all(RestingHeartRateRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("RestingHeartRate", r.beatsPerMinute.toDouble(), r.time, null, r.zoneOffset, r))
        for (r in all(HeartRateVariabilityRmssdRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("HeartRateVariabilityRmssd", r.heartRateVariabilityMillis, r.time, null, r.zoneOffset, r))
        for (r in all(OxygenSaturationRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("OxygenSaturation", r.percentage.value, r.time, null, r.zoneOffset, r))
        for (r in all(RespiratoryRateRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("RespiratoryRate", r.rate, r.time, null, r.zoneOffset, r))
        for (r in all(BodyTemperatureRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("BodyTemperature", r.temperature.inCelsius, r.time, null, r.zoneOffset, r))
        for (r in all(BloodPressureRecord::class, from, to)) if (inRange(r.time)) {
            out.put(sample("BloodPressureSystolic", r.systolic.inMillimetersOfMercury, r.time, null, r.zoneOffset, r))
            out.put(sample("BloodPressureDiastolic", r.diastolic.inMillimetersOfMercury, r.time, null, r.zoneOffset, r))
        }
        for (r in all(BloodGlucoseRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("BloodGlucose", r.level.inMillimolesPerLiter, r.time, null, r.zoneOffset, r))
        for (r in all(Vo2MaxRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("Vo2Max", r.vo2MillilitersPerMinuteKilogram, r.time, null, r.zoneOffset, r))
        for (r in all(WeightRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("Weight", r.weight.inKilograms, r.time, null, r.zoneOffset, r))
        for (r in all(HeightRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("Height", r.height.inMeters, r.time, null, r.zoneOffset, r))
        for (r in all(BodyFatRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("BodyFat", r.percentage.value, r.time, null, r.zoneOffset, r))
        for (r in all(LeanBodyMassRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("LeanBodyMass", r.mass.inKilograms, r.time, null, r.zoneOffset, r))
        for (r in all(BasalMetabolicRateRecord::class, from, to)) if (inRange(r.time))
            out.put(sample("BasalMetabolicRate", r.basalMetabolicRate.inKilocaloriesPerDay, r.time, null, r.zoneOffset, r))
        for (r in all(StepsRecord::class, from, to)) if (inRange(r.startTime))
            out.put(sample("Steps", r.count.toDouble(), r.startTime, r.endTime, r.startZoneOffset, r))
        for (r in all(DistanceRecord::class, from, to)) if (inRange(r.startTime))
            out.put(sample("Distance", r.distance.inMeters, r.startTime, r.endTime, r.startZoneOffset, r))
        for (r in all(FloorsClimbedRecord::class, from, to)) if (inRange(r.startTime))
            out.put(sample("FloorsClimbed", r.floors, r.startTime, r.endTime, r.startZoneOffset, r))
        for (r in all(ActiveCaloriesBurnedRecord::class, from, to)) if (inRange(r.startTime))
            out.put(sample("ActiveCaloriesBurned", r.energy.inKilocalories, r.startTime, r.endTime, r.startZoneOffset, r))
        for (r in all(SleepSessionRecord::class, from, to)) if (inRange(r.startTime)) {
            // each stage an interval; a session without stages one interval, "SLEEPING"
            val stages = r.stages.ifEmpty { listOf(SleepSessionRecord.Stage(r.startTime, r.endTime, SleepSessionRecord.STAGE_TYPE_SLEEPING)) }
            for (s in stages) out.put(sample("SleepSession", null, s.startTime, s.endTime, r.startZoneOffset, r).put("stage", stageName(s.stage)))
        }
        return out
    }

    private fun stageName(s: Int): String = when (s) {
        SleepSessionRecord.STAGE_TYPE_REM -> "REM"
        SleepSessionRecord.STAGE_TYPE_DEEP -> "DEEP"
        SleepSessionRecord.STAGE_TYPE_LIGHT -> "LIGHT"
        SleepSessionRecord.STAGE_TYPE_SLEEPING -> "SLEEPING"
        SleepSessionRecord.STAGE_TYPE_AWAKE -> "AWAKE"
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "AWAKE_IN_BED"
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "OUT_OF_BED"
        else -> "UNKNOWN"
    }

    private fun startOf(r: Record): Instant? = when (r) {
        is HeartRateRecord -> r.startTime
        is StepsRecord -> r.startTime
        is DistanceRecord -> r.startTime
        is FloorsClimbedRecord -> r.startTime
        is ActiveCaloriesBurnedRecord -> r.startTime
        is SleepSessionRecord -> r.startTime
        is RestingHeartRateRecord -> r.time
        is HeartRateVariabilityRmssdRecord -> r.time
        is OxygenSaturationRecord -> r.time
        is RespiratoryRateRecord -> r.time
        is BodyTemperatureRecord -> r.time
        is BloodPressureRecord -> r.time
        is BloodGlucoseRecord -> r.time
        is Vo2MaxRecord -> r.time
        is WeightRecord -> r.time
        is HeightRecord -> r.time
        is BodyFatRecord -> r.time
        is LeanBodyMassRecord -> r.time
        is BasalMetabolicRateRecord -> r.time
        else -> null
    }

    /**
     * UTC days holding records added or changed since the token, and the next token. No token yet, or one Health
     * Connect let expire (30 days unused): a fresh token and no days (the runtime reads by date meanwhile).
     */
    suspend fun changed(token: String?): Pair<List<Long>, String> {
        if (token == null) return emptyList<Long>() to client.getChangesToken(ChangesTokenRequest(readTypes.toSet()))
        val days = mutableSetOf<Long>()
        var t: String = token
        while (true) {
            val r = client.getChanges(t)
            if (r.changesTokenExpired) return emptyList<Long>() to client.getChangesToken(ChangesTokenRequest(readTypes.toSet()))
            for (c in r.changes) if (c is UpsertionChange && c.record.metadata.dataOrigin.packageName != context.packageName)
                startOf(c.record)?.let { days += Math.floorDiv(it.toEpochMilli(), 86_400_000L) }
            t = r.nextChangesToken
            if (!r.hasMore) break
        }
        return days.toList() to t
    }

    /** This app's own written records: [{id, version, value}] */
    suspend fun own(): JSONArray {
        val out = JSONArray()
        val far = Instant.ofEpochMilli(0) to Instant.now().plusSeconds(86_400)
        fun put(r: Record, v: Double) {
            val id = r.metadata.clientRecordId ?: return
            out.put(JSONObject().put("id", id).put("version", r.metadata.clientRecordVersion.toString()).put("value", v))
        }
        for (r in all(WeightRecord::class, far.first, far.second, mine = true)) put(r, r.weight.inKilograms)
        for (r in all(HeightRecord::class, far.first, far.second, mine = true)) put(r, r.height.inMeters)
        for (r in all(BodyFatRecord::class, far.first, far.second, mine = true)) put(r, r.percentage.value)
        for (r in all(LeanBodyMassRecord::class, far.first, far.second, mine = true)) put(r, r.mass.inKilograms)
        return out
    }

    /** Lab results, each under its id and version: Health Connect keeps one record per id, the higher version */
    suspend fun write(samples: JSONArray) {
        val records = mutableListOf<Record>()
        for (i in 0 until samples.length()) {
            val w = samples.getJSONObject(i)
            val at = Instant.ofEpochMilli(w.getLong("start_ms"))
            val zone = ZoneOffset.ofTotalSeconds(w.getInt("tz_min") * 60)
            val meta = Metadata.manualEntry(clientRecordId = w.getString("id"), clientRecordVersion = w.getString("version").toLong())
            val v = w.getDouble("value")
            records += when (w.getString("kind")) {
                "Weight" -> WeightRecord(time = at, zoneOffset = zone, weight = Mass.kilograms(v), metadata = meta)
                "Height" -> HeightRecord(time = at, zoneOffset = zone, height = Length.meters(v), metadata = meta)
                "BodyFat" -> BodyFatRecord(time = at, zoneOffset = zone, percentage = Percentage(v), metadata = meta)
                "LeanBodyMass" -> LeanBodyMassRecord(time = at, zoneOffset = zone, mass = Mass.kilograms(v), metadata = meta)
                else -> continue
            }
        }
        if (records.isNotEmpty()) client.insertRecords(records)
    }

    /** Deletes this app's records with these ids */
    suspend fun delete(ids: List<String>) {
        for (type in writtenTypes) client.deleteRecords(type, recordIdsList = emptyList(), clientRecordIdsList = ids)
    }
}
