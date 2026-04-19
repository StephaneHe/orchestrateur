# Keep kotlinx.serialization @Serializable classes and their synthetic companions.
-keepattributes *Annotation*
-keepclassmembers class * {
    @kotlinx.serialization.Serializable <methods>;
    @kotlinx.serialization.SerialName <methods>;
}
-keep,includedescriptorclasses class **$$serializer { *; }

# Compose and OkHttp are well-behaved out of the box; no extra rules needed for debug.
