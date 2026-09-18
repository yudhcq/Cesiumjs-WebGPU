#version 310 es


    precision highp float;
    precision highp int;





precision highp sampler3D;













layout(std140, set = 0, binding = 0) uniform CZM_UBO {
    float czm_fogDensity;
    float czm_gamma;
    mat3 czm_normal3D;
    mat4 czm_inverseModelView;
    float czm_pixelRatio;
    vec2 czm_currentFrustum;
    float czm_orthographicIn3D;
    float czm_sceneMode;
    vec4 czm_frustumPlanes;
    vec4 czm_viewport;
    float czm_frameNumber;
    float czm_eyeHeight;
    float czm_fogVisualDensityScalar;
    vec3 czm_lightDirectionWC;
    vec3 czm_sunDirectionWC;
    vec3 czm_lightColor;
    float czm_morphTime;
    vec3 czm_ellipsoidRadii;
    vec3 czm_lightDirectionEC;
    mat4 czm_inverseView;
    vec3 czm_ellipsoidInverseRadii;
    mat4 czm_view;
    float czm_splitPosition;
    vec3 czm_viewerPositionWC;
    vec3 u_radiiAndDynamicAtmosphereColor;
    float u_atmosphereLightIntensity;
    float u_atmosphereRayleighScaleHeight;
    float u_atmosphereMieScaleHeight;
    float u_atmosphereMieAnisotropy;
    vec3 u_atmosphereRayleighCoefficient;
    vec3 u_atmosphereMieCoefficient;
    vec4 u_initialColor;
    vec4 u_dayTextureTranslationAndScale[1];
    bool u_dayTextureUseWebMercatorT[1];
    vec4 u_dayTextureTexCoordsRectangle[1];
    vec2 u_lightingFadeDistance;
    vec2 u_nightFadeDistance;
    float u_minimumBrightness;
} czmUBO;

 layout(location = 0) out vec4 out_FragColor;






const float czm_epsilon7 = 0.0000001;







const float czm_infinity = 5906376272000.0;







const float czm_epsilon2 = 0.01;
















float czm_branchFreeTernary(bool comparison, float a, float b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec2 czm_branchFreeTernary(bool comparison, vec2 a, vec2 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec3 czm_branchFreeTernary(bool comparison, vec3 a, vec3 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec4 czm_branchFreeTernary(bool comparison, vec4 a, vec4 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}


















const vec4 K_HSB2RGB = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);

vec3 czm_HSBToRGB(vec3 hsb)
{
    vec3 p = abs(fract(hsb.xxx + K_HSB2RGB.xyz) * 6.0 - K_HSB2RGB.www);
    return hsb.z * mix(K_HSB2RGB.xxx, clamp(p - K_HSB2RGB.xxx, 0.0, 1.0), hsb.y);
}


















const vec4 K_RGB2HSB = vec4(0.0, - 1.0 / 3.0, 2.0 / 3.0, - 1.0);

vec3 czm_RGBToHSB(vec3 rgb)
{
    vec4 p = mix(vec4(rgb.bg, K_RGB2HSB.wz), vec4(rgb.gb, K_RGB2HSB.xy), step(rgb.b, rgb.g));
    vec4 q = mix(vec4(p.xyw, rgb.r), vec4(rgb.r, p.yzx), step(p.x, rgb.r));

    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + czm_epsilon7)), d / (q.x + czm_epsilon7), q.x);
}
















const float czm_oneOverPi = 0.3183098861837907;
















const float czm_oneOverTwoPi = 0.15915494309189535;








struct czm_ray
{
    vec3 origin;
    vec3 direction;
};








struct czm_raySegment
{
    float start;
    float stop;
};







const czm_raySegment czm_emptyRaySegment = czm_raySegment(- czm_infinity, - czm_infinity);







const czm_raySegment czm_fullRaySegment = czm_raySegment(0.0, czm_infinity);














const float czm_sceneMode2D = 2.0;
























float czm_getSpecular(vec3 lightDirectionEC, vec3 toEyeEC, vec3 normalEC, float shininess)
{
    vec3 toReflectedLight = reflect(- lightDirectionEC, normalEC);
    float specular = max(dot(toReflectedLight, toEyeEC), 0.0);



    return pow(specular, max(shininess, czm_epsilon2));
}




vec4 czm_getWaterNoise(sampler2D normalMap, vec2 uv, float time, float angleInRadians)
{
    float cosAngle = cos(angleInRadians);
    float sinAngle = sin(angleInRadians);


    vec2 s0 = vec2(1.0 / 17.0, 0.0);
    vec2 s1 = vec2(- 1.0 / 29.0, 0.0);
    vec2 s2 = vec2(1.0 / 101.0, 1.0 / 59.0);
    vec2 s3 = vec2(- 1.0 / 109.0, - 1.0 / 57.0);


    s0 = vec2( (cosAngle * s0.x) - (sinAngle * s0.y), (sinAngle * s0.x) + (cosAngle * s0.y));
    s1 = vec2( (cosAngle * s1.x) - (sinAngle * s1.y), (sinAngle * s1.x) + (cosAngle * s1.y));
    s2 = vec2( (cosAngle * s2.x) - (sinAngle * s2.y), (sinAngle * s2.x) + (cosAngle * s2.y));
    s3 = vec2( (cosAngle * s3.x) - (sinAngle * s3.y), (sinAngle * s3.x) + (cosAngle * s3.y));

    vec2 uv0 = (uv / 103.0) + (time * s0);
    vec2 uv1 = uv / 107.0 + (time * s1) + vec2(0.23);
    vec2 uv2 = uv / vec2(897.0, 983.0) + (time * s2) + vec2(0.51);
    vec2 uv3 = uv / vec2(991.0, 877.0) + (time * s3) + vec2(0.71);

    uv0 = fract(uv0);
    uv1 = fract(uv1);
    uv2 = fract(uv2);
    uv3 = fract(uv3);
    vec4 noise = (texture(normalMap, uv0)) +
                 (texture(normalMap, uv1)) +
                 (texture(normalMap, uv2)) +
                 (texture(normalMap, uv3));


    return( (noise / 4.0) - 0.5) * 2.0;
}
















vec3 czm_fog(float distanceToCamera, vec3 color, vec3 fogColor)
{
    float scalar = distanceToCamera * czmUBO.czm_fogDensity;
    float fog = 1.0 - exp(- (scalar * scalar));
    return mix(color, fogColor, fog);
}














vec3 czm_fog(float distanceToCamera, vec3 color, vec3 fogColor, float fogModifierConstant)
{
    float scalar = distanceToCamera * czmUBO.czm_fogDensity;
    float fog = 1.0 - exp(- ( (fogModifierConstant * scalar + fogModifierConstant) * (scalar * (1.0 + fogModifierConstant))));
    return mix(color, fogColor, fog);
}










vec3 czm_inverseGamma(vec3 color) {
    return pow(color, vec3(1.0 / czmUBO.czm_gamma));
}






vec3 czm_pbrNeutralTonemapping(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;

    float x = min(color.r, min(color.g, color.b));
    float offset = czm_branchFreeTernary(x < 0.08, x - 6.25 * x * x, 0.04);
    color -= offset;

    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;

    const float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;

    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, newPeak * vec3(1.0, 1.0, 1.0), g);
}










vec3 czm_applyHSBShift(vec3 rgb, vec3 hsbShift, bool ignoreBlackPixels) {

    vec3 hsb = czm_RGBToHSB(rgb);



    hsb.x += hsbShift.x;
    hsb.y = clamp(hsb.y + hsbShift.y, 0.0, 1.0);





    if (ignoreBlackPixels) {
        hsb.z = hsb.z > czm_epsilon7 ? hsb.z + hsbShift.z : 0.0;
    } else {
        hsb.z = hsb.z + hsbShift.z;
    }
    hsb.z = clamp(hsb.z, 0.0, 1.0);


    return czm_HSBToRGB(hsb);
}









bool czm_backFacing()
{

    return gl_FrontFacing == false;
}

















struct czm_material
{
    vec3 diffuse;
    float specular;
    float shininess;
    vec3 normal;
    vec3 emission;
    float alpha;
};


















struct czm_materialInput
{
    float s;
    vec2 st;
    vec3 str;
    vec3 normalEC;
    mat3 tangentToEyeMatrix;
    vec3 positionToEyeEC;
    float height;
    float slope;
    float aspect;
    float waterMask;
};








vec2 czm_ellipsoidTextureCoordinates(vec3 normal)
{
    return vec2(atan(normal.y, normal.x) * czm_oneOverTwoPi + 0.5, asin(normal.z) * czm_oneOverPi + 0.5);
}























mat3 czm_eastNorthUpToEyeCoordinates(vec3 positionMC, vec3 normalEC)
{
    vec3 tangentMC = normalize(vec3(- positionMC.y, positionMC.x, 0.0));
    vec3 tangentEC = normalize(czmUBO.czm_normal3D * tangentMC);
    vec3 bitangentEC = normalize(cross(normalEC, tangentEC));

    return mat3(
        tangentEC.x, tangentEC.y, tangentEC.z,
        bitangentEC.x, bitangentEC.y, bitangentEC.z,
        normalEC.x, normalEC.y, normalEC.z);
}












const float czm_sceneMode3D = 3.0;











const float czm_sceneModeColumbusView = 1.0;




















float czm_getLambertDiffuse(vec3 lightDirectionEC, vec3 normalEC)
{
    return max(dot(lightDirectionEC, normalEC), 0.0);
}













vec3 czm_geodeticSurfaceNormal(vec3 positionOnEllipsoid, vec3 ellipsoidCenter, vec3 oneOverEllipsoidRadiiSquared)
{
    return normalize( (positionOnEllipsoid - ellipsoidCenter) * oneOverEllipsoidRadiiSquared);
}

















vec3 czm_pointAlongRay(czm_ray ray, float time)
{
    return ray.origin + (time * ray.direction);
}








czm_raySegment czm_rayEllipsoidIntersectionInterval(czm_ray ray, vec3 ellipsoid_center, vec3 ellipsoid_inverseRadii)
{

    vec3 q = ellipsoid_inverseRadii * (czmUBO.czm_inverseModelView * vec4(ray.origin, 1.0)).xyz;
    vec3 w = ellipsoid_inverseRadii * (czmUBO.czm_inverseModelView * vec4(ray.direction, 0.0)).xyz;

    q = q - ellipsoid_inverseRadii * (czmUBO.czm_inverseModelView * vec4(ellipsoid_center, 1.0)).xyz;

    float q2 = dot(q, q);
    float qw = dot(q, w);

    if (q2 > 1.0)
    {
        if (qw >= 0.0)
        {
            return czm_emptyRaySegment;
        }
        else
        {
            float qw2 = qw * qw;
            float difference = q2 - 1.0;
            float w2 = dot(w, w);
            float product = w2 * difference;

            if (qw2 < product)
            {
                return czm_emptyRaySegment;
            }
            else if (qw2 > product)
            {
                float discriminant = qw * qw - product;
                float temp = - qw + sqrt(discriminant);
                float root0 = temp / w2;
                float root1 = difference / temp;
                if (root0 < root1)
                {
                    czm_raySegment i = czm_raySegment(root0, root1);
                    return i;
                }
                else
                {
                    czm_raySegment i = czm_raySegment(root1, root0);
                    return i;
                }
            }
            else
            {
                float root = sqrt(difference / w2);
                czm_raySegment i = czm_raySegment(root, root);
                return i;
            }
        }
    }
    else if (q2 < 1.0)
    {
        float difference = q2 - 1.0;
        float w2 = dot(w, w);
        float product = w2 * difference;
        float discriminant = qw * qw - product;
        float temp = - qw + sqrt(discriminant);
        czm_raySegment i = czm_raySegment(0.0, temp / w2);
        return i;
    }
    else
    {
        if (qw < 0.0)
        {
            float w2 = dot(w, w);
            czm_raySegment i = czm_raySegment(0.0, - qw / w2);
            return i;
        }
        else
        {
            return czm_emptyRaySegment;
        }
    }
}















float czm_metersPerPixel(vec4 positionEC, float pixelRatio)
{
    float width = czmUBO.czm_viewport.z;
    float height = czmUBO.czm_viewport.w;
    float pixelWidth;
    float pixelHeight;

    float top = czmUBO.czm_frustumPlanes.x;
    float bottom = czmUBO.czm_frustumPlanes.y;
    float left = czmUBO.czm_frustumPlanes.z;
    float right = czmUBO.czm_frustumPlanes.w;

    if (czmUBO.czm_sceneMode == czm_sceneMode2D || czmUBO.czm_orthographicIn3D == 1.0)
    {
        float frustumWidth = right - left;
        float frustumHeight = top - bottom;
        pixelWidth = frustumWidth / width;
        pixelHeight = frustumHeight / height;
    }
    else
    {
        float distanceToPixel = - positionEC.z;
        float inverseNear = 1.0 / czmUBO.czm_currentFrustum.x;
        float tanTheta = top * inverseNear;
        pixelHeight = 2.0 * distanceToPixel * tanTheta / height;
        tanTheta = right * inverseNear;
        pixelWidth = 2.0 * distanceToPixel * tanTheta / width;
    }

    return max(pixelWidth, pixelHeight) * pixelRatio;
}













float czm_metersPerPixel(vec4 positionEC)
{
    return czm_metersPerPixel(positionEC, czmUBO.czm_pixelRatio);
}
















vec3 czm_saturation(vec3 rgb, float adjustment)
{

    const vec3 W = vec3(0.2125, 0.7154, 0.0721);
    vec3 intensity = vec3(dot(rgb, W));
    return mix(intensity, rgb, adjustment);
}















vec3 czm_hue(vec3 rgb, float adjustment)
{
    const mat3 toYIQ = mat3(0.299, 0.587, 0.114,
                            0.595716, - 0.274453, - 0.321263,
                            0.211456, - 0.522591, 0.311135);
    const mat3 toRGB = mat3(1.0, 0.9563, 0.6210,
                            1.0, - 0.2721, - 0.6474,
                            1.0, - 1.107, 1.7046);

    vec3 yiq = toYIQ * rgb;
    float hue = atan(yiq.z, yiq.y) + adjustment;
    float chroma = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);

    vec3 color = vec3(yiq.x, chroma * cos(hue), chroma * sin(hue));
    return toRGB * color;
}











vec3 czm_gammaCorrect(vec3 color) {



    return color;
}

vec4 czm_gammaCorrect(vec4 color) {



    return color;
}










float czm_maximumComponent(vec2 v)
{
    return max(v.x, v.y);
}
float czm_maximumComponent(vec3 v)
{
    return max(max(v.x, v.y), v.z);
}
float czm_maximumComponent(vec4 v)
{
    return max(max(max(v.x, v.y), v.z), v.w);
}








float czm_approximateTanh(float x) {
    float x2 = x * x;
    return max(- 1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2)));
}












czm_raySegment czm_raySphereIntersectionInterval(czm_ray ray, vec3 center, float radius)
{
    vec3 o = ray.origin;
    vec3 d = ray.direction;

    vec3 oc = o - center;

    float a = dot(d, d);
    float b = 2.0 * dot(d, oc);
    float c = dot(oc, oc) - (radius * radius);

    float det = (b * b) - (4.0 * a * c);

    if (det < 0.0) {
        return czm_emptyRaySegment;
    }

    float sqrtDet = sqrt(det);

    float t0 = (- b - sqrtDet) / (2.0 * a);
    float t1 = (- b + sqrtDet) / (2.0 * a);

    czm_raySegment result = czm_raySegment(t0, t1);
    return result;
}












const float ATMOSPHERE_THICKNESS = 111e3;
const int PRIMARY_STEPS_MAX = 16;
const int LIGHT_STEPS_MAX = 4;













void computeScattering(
    czm_ray primaryRay,
    float primaryRayLength,
    vec3 lightDirection,
    float atmosphereInnerRadius,
    out vec3 rayleighColor,
    out vec3 mieColor,
    out float opacity
) {


    rayleighColor = vec3(0.0);
    mieColor = vec3(0.0);
    opacity = 0.0;

    float atmosphereOuterRadius = atmosphereInnerRadius + ATMOSPHERE_THICKNESS;

    vec3 origin = vec3(0.0);


    czm_raySegment primaryRayAtmosphereIntersect = czm_raySphereIntersectionInterval(primaryRay, origin, atmosphereOuterRadius);


    if (primaryRayAtmosphereIntersect == czm_emptyRaySegment) {
        return;
    }





    float x = 1e-7 * primaryRayAtmosphereIntersect.stop / length(primaryRayLength);


    float w_stop_gt_lprl = 0.5 * (1.0 + czm_approximateTanh(x));


    float start_0 = primaryRayAtmosphereIntersect.start;
    primaryRayAtmosphereIntersect.start = max(primaryRayAtmosphereIntersect.start, 0.0);

    primaryRayAtmosphereIntersect.stop = min(primaryRayAtmosphereIntersect.stop, length(primaryRayLength));




    float x_o_a = start_0 - ATMOSPHERE_THICKNESS;
    float w_inside_atmosphere = 1.0 - 0.5 * (1.0 + czm_approximateTanh(x_o_a));
    int PRIMARY_STEPS = PRIMARY_STEPS_MAX - int(w_inside_atmosphere * 12.0);
    int LIGHT_STEPS = LIGHT_STEPS_MAX - int(w_inside_atmosphere * 2.0);


    float rayPositionLength = primaryRayAtmosphereIntersect.start;


    float totalRayLength = primaryRayAtmosphereIntersect.stop - rayPositionLength;
    float rayStepLengthIncrease = w_inside_atmosphere * ( (1.0 - w_stop_gt_lprl) * totalRayLength / (float(PRIMARY_STEPS * (PRIMARY_STEPS + 1)) / 2.0));
    float rayStepLength = max(1.0 - w_inside_atmosphere, w_stop_gt_lprl) * totalRayLength / max(7.0 * w_inside_atmosphere, float(PRIMARY_STEPS));

    vec3 rayleighAccumulation = vec3(0.0);
    vec3 mieAccumulation = vec3(0.0);
    vec2 opticalDepth = vec2(0.0);
    vec2 heightScale = vec2(czmUBO.u_atmosphereRayleighScaleHeight, czmUBO.u_atmosphereMieScaleHeight);


    for (int i = 0; i < PRIMARY_STEPS_MAX; ++ i) {



        if (i >= PRIMARY_STEPS) {
            break;
        }


        vec3 samplePosition = primaryRay.origin + primaryRay.direction * (rayPositionLength + rayStepLength);


        float sampleHeight = length(samplePosition) - atmosphereInnerRadius;


        vec2 sampleDensity = exp(- sampleHeight / heightScale) * rayStepLength;
        opticalDepth += sampleDensity;


        czm_ray lightRay = czm_ray(samplePosition, lightDirection);
        czm_raySegment lightRayAtmosphereIntersect = czm_raySphereIntersectionInterval(lightRay, origin, atmosphereOuterRadius);

        float lightStepLength = lightRayAtmosphereIntersect.stop / float(LIGHT_STEPS);
        float lightPositionLength = 0.0;

        vec2 lightOpticalDepth = vec2(0.0);


        for (int j = 0; j < LIGHT_STEPS_MAX; ++ j) {



            if (j >= LIGHT_STEPS) {
                break;
            }


            vec3 lightPosition = samplePosition + lightDirection * (lightPositionLength + lightStepLength * 0.5);


            float lightHeight = length(lightPosition) - atmosphereInnerRadius;


            lightOpticalDepth += exp(- lightHeight / heightScale) * lightStepLength;


            lightPositionLength += lightStepLength;
        }


        vec3 attenuation = exp(- ( (czmUBO.u_atmosphereMieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) + (czmUBO.u_atmosphereRayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x))));


        rayleighAccumulation += sampleDensity.x * attenuation;
        mieAccumulation += sampleDensity.y * attenuation;


        rayPositionLength += (rayStepLength += rayStepLengthIncrease);
    }


    rayleighColor = czmUBO.u_atmosphereRayleighCoefficient * rayleighAccumulation;
    mieColor = czmUBO.u_atmosphereMieCoefficient * mieAccumulation;


    opacity = length(exp(- ( (czmUBO.u_atmosphereMieCoefficient * opticalDepth.y) + (czmUBO.u_atmosphereRayleighCoefficient * opticalDepth.x))));
}

vec4 computeAtmosphereColor(
    vec3 positionWC,
    vec3 lightDirection,
    vec3 rayleighColor,
    vec3 mieColor,
    float opacity
) {

    vec3 cameraToPositionWC = positionWC - czmUBO.czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);

    float cosAngle = dot(cameraToPositionWCDirection, lightDirection);
    float cosAngleSq = cosAngle * cosAngle;

    float G = czmUBO.u_atmosphereMieAnisotropy;
    float GSq = G * G;


    float rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);

    float miePhase = 3.0 / (25.1327412287) * ( (1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));


    vec3 rayleigh = rayleighPhase * rayleighColor;
    vec3 mie = miePhase * mieColor;

    vec3 color = (rayleigh + mie) * czmUBO.u_atmosphereLightIntensity;

    return vec4(color, opacity);
}


 void computeAtmosphereScattering(vec3 positionWC, vec3 lightDirection, out vec3 rayleighColor, out vec3 mieColor, out float opacity) {
    vec3 cameraToPositionWC = positionWC - czmUBO.czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);
    czm_ray primaryRay = czm_ray(czmUBO.czm_viewerPositionWC, cameraToPositionWCDirection);

    float atmosphereInnerRadius = length(positionWC);

    computeScattering(
        primaryRay,
        length(cameraToPositionWC),
        lightDirection,
        atmosphereInnerRadius,
        rayleighColor,
        mieColor,
        opacity
    );
}




layout(binding = 17) uniform sampler2D u_dayTextures[1];





























































































































layout(location = 0) in vec3 v_positionMC;
layout(location = 1) in vec3 v_positionEC;
layout(location = 2) in vec3 v_textureCoordinates;
layout(location = 3) in vec3 v_normalMC;
layout(location = 4) in vec3 v_normalEC;








layout(location = 5) in float v_distance;



layout(location = 6) in vec3 v_atmosphereRayleighColor;
layout(location = 7) in vec3 v_atmosphereMieColor;
layout(location = 8) in float v_atmosphereOpacity;
































vec4 sampleAndBlend(
    vec4 previousColor,
    sampler2D textureToSample,
    vec2 tileTextureCoordinates,
    vec4 textureCoordinateRectangle,
    vec4 textureCoordinateTranslationAndScale,
    float textureAlpha,
    float textureNightAlpha,
    float textureDayAlpha,
    float textureBrightness,
    float textureContrast,
    float textureHue,
    float textureSaturation,
    float textureOneOverGamma,
    float split,
    vec4 colorToAlpha,
    float nightBlend)
{







    vec2 alphaMultiplier = step(textureCoordinateRectangle.st, tileTextureCoordinates);
    textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;

    alphaMultiplier = step(vec2(0.0), textureCoordinateRectangle.pq - tileTextureCoordinates);
    textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;





    vec2 translation = textureCoordinateTranslationAndScale.xy;
    vec2 scale = textureCoordinateTranslationAndScale.zw;
    vec2 textureCoordinates = tileTextureCoordinates * scale + translation;
    vec4 value = texture(textureToSample, textureCoordinates);
    vec3 color = value.rgb;
    float alpha = value.a;








    vec4 tempColor = czm_gammaCorrect(vec4(color, alpha));
    color = tempColor.rgb;
    alpha = tempColor.a;
































    float sourceAlpha = alpha * textureAlpha;
    float outAlpha = mix(previousColor.a, 1.0, sourceAlpha);
    outAlpha += sign(outAlpha) - 1.0;

    vec3 outColor = mix(previousColor.rgb * previousColor.a, color, sourceAlpha) / outAlpha;



















    return vec4(outColor, max(outAlpha, 0.0));
}

vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend);
vec4 computeWaterColor(vec3 positionEyeCoordinates, vec2 textureCoordinates, mat3 enuToEye, vec4 imageryColor, float specularMapValue, float fade);

const float fExposure = 2.0;

vec3 computeEllipsoidPosition()
{
    float mpp = czm_metersPerPixel(vec4(0.0, 0.0, - czmUBO.czm_currentFrustum.x, 1.0), 1.0);
    vec2 xy = gl_FragCoord.xy / czmUBO.czm_viewport.zw * 2.0 - vec2(1.0);
    xy *= czmUBO.czm_viewport.zw * mpp * 0.5;

    vec3 direction;
    if (czmUBO.czm_orthographicIn3D == 1.0)
    {
        direction = vec3(0.0, 0.0, - 1.0);
    }
    else
    {
        direction = normalize(vec3(xy, - czmUBO.czm_currentFrustum.x));
    }

    czm_ray ray = czm_ray(vec3(0.0), direction);

    vec3 ellipsoid_center = czmUBO.czm_view[3].xyz;

    czm_raySegment intersection = czm_rayEllipsoidIntersectionInterval(ray, ellipsoid_center, czmUBO.czm_ellipsoidInverseRadii);

    vec3 ellipsoidPosition = czm_pointAlongRay(ray, intersection.start);
    return(czmUBO.czm_inverseView * vec4(ellipsoidPosition, 1.0)).xyz;
}

void main()
{













    vec3 normalMC = czm_geodeticSurfaceNormal(v_positionMC, vec3(0.0), vec3(1.0));
    vec3 normalEC = czmUBO.czm_normal3D * normalMC;





    float nightBlend = 0.0;






    vec4 color = computeDayColor(czmUBO.u_initialColor, clamp(v_textureCoordinates, 0.0, 1.0), nightBlend);










    float cameraDist;
    if (czmUBO.czm_sceneMode == czm_sceneMode2D)
    {
        cameraDist = max(czmUBO.czm_frustumPlanes.x - czmUBO.czm_frustumPlanes.y, czmUBO.czm_frustumPlanes.w - czmUBO.czm_frustumPlanes.z) * 0.5;
    }
    else if (czmUBO.czm_sceneMode == czm_sceneModeColumbusView)
    {
        cameraDist = - czmUBO.czm_view[3].z;
    }
    else
    {
        cameraDist = length(czmUBO.czm_view[3]);
    }
    float fadeOutDist = czmUBO.u_lightingFadeDistance.x;
    float fadeInDist = czmUBO.u_lightingFadeDistance.y;
    if (czmUBO.czm_sceneMode != czm_sceneMode3D) {
        vec3 radii = czmUBO.czm_ellipsoidRadii;
        float maxRadii = max(radii.x, max(radii.y, radii.z));
        fadeOutDist -= maxRadii;
        fadeInDist -= maxRadii;
    }
    float fade = clamp( (cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.0, 1.0);

















































    float diffuseIntensity = clamp(czm_getLambertDiffuse(czmUBO.czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);
    diffuseIntensity = mix(1.0, diffuseIntensity, fade);
    vec4 finalColor = vec4(color.rgb * czmUBO.czm_lightColor * diffuseIntensity, color.a);

































    vec3 atmosphereLightDirection = czmUBO.czm_sunDirectionWC;





    if (! czm_backFacing())
    {
        bool dynamicLighting = false;

            dynamicLighting = true;


        vec3 rayleighColor;
        vec3 mieColor;
        float opacity;

        vec3 positionWC;
        vec3 lightDirection;














            positionWC = v_positionMC;
            lightDirection = czm_branchFreeTernary(dynamicLighting, atmosphereLightDirection, normalize(positionWC));
            rayleighColor = v_atmosphereRayleighColor;
            mieColor = v_atmosphereMieColor;
            opacity = v_atmosphereOpacity;








        vec4 groundAtmosphereColor = computeAtmosphereColor(positionWC, lightDirection, rayleighColor, mieColor, opacity);
























            const float transmittanceModifier = 0.5;
            float transmittance = transmittanceModifier + clamp(1.0 - groundAtmosphereColor.a, 0.0, 1.0);

            vec3 finalAtmosphereColor = finalColor.rgb + groundAtmosphereColor.rgb * transmittance;


                float fadeInDist = czmUBO.u_nightFadeDistance.x;
                float fadeOutDist = czmUBO.u_nightFadeDistance.y;

                float sunlitAtmosphereIntensity = clamp( (cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.05, 1.0);
                float darken = clamp(dot(normalize(positionWC), atmosphereLightDirection), 0.0, 1.0);
                vec3 darkenendGroundAtmosphereColor = mix(groundAtmosphereColor.rgb, finalAtmosphereColor.rgb, darken);

                finalAtmosphereColor = mix(darkenendGroundAtmosphereColor, finalAtmosphereColor, sunlitAtmosphereIntensity);



                finalAtmosphereColor.rgb = vec3(1.0) - exp(- fExposure * finalAtmosphereColor.rgb);




            finalColor.rgb = mix(finalColor.rgb, finalAtmosphereColor.rgb, fade);

    }


























    out_FragColor = finalColor;
}










































































































 vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend){
    vec4 color = initialColor;
    color = sampleAndBlend(
        color,
        u_dayTextures[0],
        czmUBO.u_dayTextureUseWebMercatorT[0] ? textureCoordinates.xz : textureCoordinates.xy,
        czmUBO.u_dayTextureTexCoordsRectangle[0],
        czmUBO.u_dayTextureTranslationAndScale[0],
        1.0,
        1.0,
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        vec4(0.0),
        nightBlend);
    return color;
}

